# URBONT API — Despliegue en AWS ECS Fargate

Despliegue de `urbont-api` en ECS Fargate detrás de un Application Load Balancer,
con un solo task. La imagen se construye en local y se sube a mano a ECR: no hay
despliegue automático.

Región `us-east-1`, perfil `urbont`. Escalar a varias instancias está en el
[Anexo](#anexo--escalar-a-2-tasks) — el código todavía no lo soporta.

---

## Antes de empezar

**Los secretos van dentro de la imagen.** El `.env` se copia a `/app/.env` en el
`Dockerfile`, en una capa inmutable que `docker history` puede leer. Quien pueda
hacer `docker pull` del repositorio tiene las claves de Stripe, Supabase y
Firebase. Mitigación: repositorio de ECR privado y pocas imágenes retenidas
(Paso 1).

**El servicio va con `desiredCount=1`.** No es un valor por defecto, es una
decisión: el código guarda estado en memoria del proceso y solo es correcto con
una instancia.

| Problema | Dónde | Efecto con 2+ tasks |
|---|---|---|
| Cron sin guarda | [`server.ts:985`](../server.ts#L985) | 14 jobs duplicados; viajes reasignados dos veces |
| `driverSocketMap` en memoria | [`socketService.ts:607`](../server/services/socketService.ts#L607) | El conductor en otra instancia no recibe la oferta |
| Rate limiter en memoria | [`server.ts:73-91`](../server.ts#L73-L91) | El límite se multiplica por el número de tasks |
| Timers de proceso | [`socketService.ts:43-81`](../server/services/socketService.ts#L43-L81) | Reasignaciones perdidas al reciclar |

Detalle en [`CRON_JOBS.md`](CRON_JOBS.md).

```
docker build + push
   └→ ECR (privado, con el .env dentro)
        └→ ECS Fargate ARM64 · 0.5 vCPU / 1 GB · 1 task
             ├→ ALB (HTTPS, stickiness, /api/healthz)
             ├→ CloudWatch Logs
             └→ Supabase · Stripe · FCM · Twilio · Resend
```

Comprueba la identidad y anota el número de cuenta — es el `<ACCT>` de los ARNs:

```bash
aws sts get-caller-identity --profile urbont
```

---

## Paso 1 — Repositorio en ECR

```bash
aws ecr create-repository \
  --repository-name urbont-api \
  --image-scanning-configuration scanOnPush=true \
  --region us-east-1 --profile urbont
```

Confirma que es privado. Debe responder `RepositoryPolicyNotFoundException`; si
devuelve una política con `"Principal": "*"`, bórrala:

```bash
aws ecr get-repository-policy --repository-name urbont-api \
  --region us-east-1 --profile urbont
```

Cada imagen retenida es una copia más de tus secretos, así que conserva pocas:

```bash
aws ecr put-lifecycle-policy \
  --repository-name urbont-api \
  --lifecycle-policy-text '{
    "rules": [{
      "rulePriority": 1,
      "description": "Conservar solo las ultimas 5 imagenes",
      "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 5 },
      "action": { "type": "expire" }
    }]
  }' \
  --region us-east-1 --profile urbont
```

`countType` solo admite `imageCountMoreThan`, `sinceImagePushed`,
`sinceImagePulled` y `sinceImageTransitioned`. Otro valor da
`InvalidParameterException: matched 0 out of 4`.

---

## Paso 2 — Variables de entorno

No se crea nada en AWS. `server.ts` hace `import "dotenv/config"` en su
[primera línea](../server.ts#L1) y lee `/app/.env`, que el `Dockerfile` copia
dentro de la imagen.

**El `.env` de la raíz es el de desarrollo.** Construir con él manda `PORT=5000`
y un `ALLOWED_ORIGIN` sin los dominios reales a producción; se manifiesta como
errores de CORS en la app. Verifica antes de construir:

```bash
grep -E '^(ALLOWED_ORIGIN|SUPABASE_URL|PORT)=' .env
```

### Qué gana sobre qué

`dotenv` no sobrescribe variables que ya existan en el entorno:

| Prioridad | Origen |
|---|---|
| 1 | `environment` del task definition |
| 2 | `ENV` del `Dockerfile` |
| 3 | `.env` de la imagen |

Por eso el task definition repite `ALLOWED_ORIGIN`, `NODE_ENV` y `PORT` (Paso 7):
son la red de seguridad si la imagen se construyó con el `.env` equivocado.

---

## Paso 3 — Red

VPC por defecto, subnets públicas, `assignPublicIp=ENABLED`. El server necesita
salida a internet; en subnets privadas haría falta un NAT Gateway, $33/mes que no
aportan nada aquí porque el ALB es el único que acepta tráfico entrante.

```bash
VPC=$(aws ec2 describe-vpcs \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text \
  --region us-east-1 --profile urbont)

aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC \
  --query 'Subnets[].{id:SubnetId,az:AvailabilityZone}' --output table \
  --region us-east-1 --profile urbont
```

Elige **dos subnets de zonas distintas** — el ALB lo exige:

```bash
SUBNET_A=subnet-xxxxxxxx
SUBNET_B=subnet-yyyyyyyy
```

Los security groups: el del ALB acepta tráfico público, el de los tasks solo
acepta al ALB. `create-security-group` devuelve el ID, captúralo.

**Ejecútalo en dos tandas.** El shell no se detiene ante un error: si un
`create-security-group` falla, la variable queda vacía y los `authorize`
siguientes fallan con errores confusos sobre un `--group-id` inválido.

```bash
SG_ALB=$(aws ec2 create-security-group \
  --group-name urbont-alb-sg --description "ALB urbont-api" \
  --vpc-id $VPC --query 'GroupId' --output text \
  --region us-east-1 --profile urbont)

SG_TASK=$(aws ec2 create-security-group \
  --group-name urbont-task-sg --description "Tasks urbont-api" \
  --vpc-id $VPC --query 'GroupId' --output text \
  --region us-east-1 --profile urbont)

echo "SG_ALB=$SG_ALB  SG_TASK=$SG_TASK"
```

**Comprueba que el `echo` muestra dos IDs `sg-0...`** antes de seguir. Si alguno
sale vacío, ve a *Si algo falla* más abajo.

```bash
aws ec2 authorize-security-group-ingress --group-id $SG_ALB \
  --protocol tcp --port 443 --cidr 0.0.0.0/0 \
  --region us-east-1 --profile urbont

aws ec2 authorize-security-group-ingress --group-id $SG_ALB \
  --protocol tcp --port 80 --cidr 0.0.0.0/0 \
  --region us-east-1 --profile urbont

aws ec2 authorize-security-group-ingress --group-id $SG_TASK \
  --protocol tcp --port 8080 --source-group $SG_ALB \
  --region us-east-1 --profile urbont

echo "VPC=$VPC  SUBNET_A=$SUBNET_A  SUBNET_B=$SUBNET_B  SG_ALB=$SG_ALB  SG_TASK=$SG_TASK"
```

Apunta esos cinco valores: si cierras la terminal se pierden, y hacen falta en
los Pasos 5 y 9.

### Si algo falla

**`$VPC` vacío** — estás en una terminal distinta de donde la definiste.
Recupérala con el primer comando de este paso.

**`InvalidGroup.Duplicate`** — los grupos ya existen de un intento anterior.
Recupera sus IDs en vez de crearlos:

```bash
SG_ALB=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values=urbont-alb-sg Name=vpc-id,Values=$VPC \
  --query 'SecurityGroups[0].GroupId' --output text \
  --region us-east-1 --profile urbont)

SG_TASK=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values=urbont-task-sg Name=vpc-id,Values=$VPC \
  --query 'SecurityGroups[0].GroupId' --output text \
  --region us-east-1 --profile urbont)

echo "SG_ALB=$SG_ALB  SG_TASK=$SG_TASK"
```

**`InvalidPermission.Duplicate`** en un `authorize` — esa regla ya estaba puesta.
Es inofensivo, sigue adelante.

---

## Paso 4 — Certificado TLS

Lánzalo pronto: la validación tarda unos minutos y bloquea el Paso 5.

```bash
aws acm request-certificate \
  --domain-name api.urbont.com \
  --validation-method DNS \
  --region us-east-1 --profile urbont
```

Añade a tu DNS el CNAME que devuelve, y espera a que el estado sea `ISSUED`:

```bash
aws acm describe-certificate --certificate-arn $CERT_ARN \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord' \
  --region us-east-1 --profile urbont

aws acm describe-certificate --certificate-arn $CERT_ARN \
  --query 'Certificate.Status' --output text \
  --region us-east-1 --profile urbont
```

---

## Paso 5 — ALB y target group

```bash
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name urbont-api-alb \
  --type application --scheme internet-facing \
  --subnets $SUBNET_A $SUBNET_B \
  --security-groups $SG_ALB \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text \
  --region us-east-1 --profile urbont)

TG_ARN=$(aws elbv2 create-target-group \
  --name urbont-api-tg \
  --protocol HTTP --port 8080 \
  --vpc-id $VPC \
  --target-type ip \
  --health-check-path /api/healthz \
  --health-check-interval-seconds 30 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text \
  --region us-east-1 --profile urbont)

echo "ALB_ARN=$ALB_ARN"
echo "TG_ARN=$TG_ARN"

```

`--target-type ip` es obligatorio con Fargate.

### Stickiness e idle timeout

Socket.IO tiene `polling` activo
([`socketService.ts:232`](../server/services/socketService.ts#L232)), y el
handshake por polling son varias peticiones que deben caer en el mismo task. Con
un task da igual, pero configúralo ahora: es gratis y evita un fallo intermitente
el día que escales.

El keepalive de Socket.IO es de 40s (`pingInterval` 10 + `pingTimeout` 30) y el
ALB corta a los 60 por defecto. Súbelo a 300.

```bash
aws elbv2 modify-target-group-attributes --target-group-arn $TG_ARN \
  --attributes \
    Key=stickiness.enabled,Value=true \
    Key=stickiness.type,Value=lb_cookie \
    Key=stickiness.lb_cookie.duration_seconds,Value=86400 \
    Key=deregistration_delay.timeout_seconds,Value=15 \
  --region us-east-1 --profile urbont

aws elbv2 modify-load-balancer-attributes --load-balancer-arn $ALB_ARN \
  --attributes Key=idle_timeout.timeout_seconds,Value=300 \
  --region us-east-1 --profile urbont
```

`deregistration_delay=15` encaja con el shutdown graceful, que fuerza salida a
los 10s ([`server.ts:1029-1046`](../server.ts#L1029-L1046)).

### Listener HTTP

Un solo listener en el 80 que reenvía al target group. Con esto ya puedes
desplegar y verificar; el HTTPS se añade después, sin recrear nada.

```bash
aws elbv2 create-listener --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN \
  --region us-east-1 --profile urbont
```

Guarda la URL del ALB — es con la que vas a probar. Tarda 2-3 minutos en pasar a
`active` y aceptar tráfico:

```bash
ALB_DNS=$(aws elbv2 describe-load-balancers --names urbont-api-alb \
  --query 'LoadBalancers[0].DNSName' --output text \
  --region us-east-1 --profile urbont)

echo "http://$ALB_DNS/api/healthz"
```

### Pasar a HTTPS (cuando el certificado esté `ISSUED`)

Esa URL de `elb.amazonaws.com` es de AWS, así que **nunca podrá tener
certificado**: es HTTP para siempre. Sirve para probar, no para producción —
Stripe no envía webhooks a HTTP, Android bloquea tráfico en claro desde la
versión 9, y el navegador bloquea llamadas `http://` desde una página `https://`.

Cuando el certificado del Paso 4 esté validado, añade el listener 443 y convierte
el 80 en redirect:

```bash
CERT_ARN=$(aws acm list-certificates \
  --query "CertificateSummaryList[?DomainName=='api.urbont.com'].CertificateArn | [0]" \
  --output text --region us-east-1 --profile urbont)

aws elbv2 create-listener --load-balancer-arn $ALB_ARN \
  --protocol HTTPS --port 443 \
  --certificates CertificateArn=$CERT_ARN \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN \
  --region us-east-1 --profile urbont

LISTENER_80=$(aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN \
  --query 'Listeners[?Port==`80`].ListenerArn | [0]' --output text \
  --region us-east-1 --profile urbont)

aws elbv2 modify-listener --listener-arn $LISTENER_80 \
  --default-actions '{
    "Type":"redirect",
    "RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}
  }' \
  --region us-east-1 --profile urbont
```

Después toca el Paso 10 (DNS) y actualizar la URL del webhook en Stripe.

---

## Paso 6 — Roles IAM

`ecsTaskExecutionRole` lo usa el agente de ECS para bajar la imagen y escribir
logs. `urbontApiTaskRole` es el de la aplicación y va sin políticas: el código no
usa el SDK de AWS.

```bash
cat > /tmp/ecs-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON

aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document file:///tmp/ecs-trust.json \
  --profile urbont

aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
  --profile urbont

aws iam create-role \
  --role-name urbontApiTaskRole \
  --assume-role-policy-document file:///tmp/ecs-trust.json \
  --profile urbont
```

`ecsTaskExecutionRole` es un nombre estándar y puede existir ya: si falla con
`EntityAlreadyExists`, ignóralo. `aws iam` es global, no lleva `--region`.

**La policy gestionada no incluye `logs:CreateLogGroup`.** El `taskdef.json`
(Paso 7) pone `"awslogs-create-group": "true"`, así que el agente de ECS
intenta crear el log group él mismo en cada arranque. `AmazonECSTaskExecutionRolePolicy`
da `CreateLogStream`/`PutLogEvents` pero no `CreateLogGroup`, y sin este permiso
el task nunca arranca: el servicio queda con `running=0` en un bucle silencioso
de start/fail, y el único rastro es
`AccessDeniedException ... logs:CreateLogGroup` en `services[0].events`. Dale el
permiso ahora, antes del Paso 9:

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text --profile urbont)

cat > /tmp/logs-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "logs:CreateLogGroup",
    "Resource": "arn:aws:logs:us-east-1:$ACCT:log-group:/ecs/urbont-api:*"
  }]
}
JSON

aws iam put-role-policy --role-name ecsTaskExecutionRole \
  --policy-name urbont-logs-creategroup \
  --policy-document file:///tmp/logs-policy.json \
  --profile urbont
```

Si el servicio ya está creado y atascado en `running=0`, el fix inmediato es
crear el log group a mano y forzar redeploy — no hace falta esperar a que
propague el permiso:

```bash
aws logs create-log-group --log-group-name /ecs/urbont-api \
  --region us-east-1 --profile urbont   # ResourceAlreadyExistsException: ignóralo

aws ecs update-service --cluster urbont --service urbont-api \
  --force-new-deployment --region us-east-1 --profile urbont
```

---

## Paso 7 — Task definition

`taskdef.json` en la raíz del repo. Sin bloque `secrets`: las variables vienen
del `.env` de la imagen.

```json
{
  "family": "urbont-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "runtimePlatform": {
    "cpuArchitecture": "ARM64",
    "operatingSystemFamily": "LINUX"
  },
  "executionRoleArn": "arn:aws:iam::<ACCT>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<ACCT>:role/urbontApiTaskRole",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "<ACCT>.dkr.ecr.us-east-1.amazonaws.com/urbont-api:latest",
      "essential": true,
      "stopTimeout": 15,
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "8080" },
        { "name": "CRON_ENABLED", "value": "true" },
        {
          "name": "ALLOWED_ORIGIN",
          "value": "https://app.urbont.com,https://admin.urbont.com,https://urbont.com,capacitor://localhost"
        }
      ],
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "node -e \"fetch('http://localhost:8080/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        ],
        "interval": 30,
        "timeout": 10,
        "retries": 3,
        "startPeriod": 40
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/urbont-api",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "api",
          "awslogs-create-group": "true"
        }
      }
    }
  ]
}
```

JSON no expande variables de shell, así que los tres `<ACCT>` se sustituyen al
registrar. El `taskdef.json` del repo se queda con el placeholder:

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text \
  --region us-east-1 --profile urbont)

sed "s/<ACCT>/$ACCT/g" taskdef.json > /tmp/taskdef.json

grep -c "$ACCT" /tmp/taskdef.json    # deben salir 3

aws ecs register-task-definition --cli-input-json file:///tmp/taskdef.json \
  --region us-east-1 --profile urbont
```

Tres barras en `file:///tmp/...`: dos del esquema más la de la ruta absoluta.

| Valor | Motivo |
|---|---|
| `ARM64` | $14/mes frente a $18 en x86. `node:22-alpine` es multi-arch |
| `startPeriod: 40` | El arranque corre migraciones y verifica el esquema antes de escuchar ([`server.ts:1002-1021`](../server.ts#L1002-L1021)) |
| `stopTimeout: 15` | El shutdown graceful fuerza salida a los 10s |
| `512` / `1024` | PM2 usaba 512M; 1 GB da holgura |

**`runtimePlatform` y el `--platform` del build tienen que coincidir** o el task
muere con `exec format error`. Si construyes desde un Mac Intel, `linux/arm64`
usa emulación QEMU y va lento porque el `Dockerfile` compila módulos nativos: en
ese caso pon `X86_64` y `linux/amd64` en ambos sitios.

---

## Paso 8 — Construir y subir la imagen

Antes de crear el servicio: ECS intenta bajar la imagen en cuanto el servicio
existe y falla si no está.

```bash
REPO=<ACCT>.dkr.ecr.us-east-1.amazonaws.com/urbont-api

aws ecr get-login-password --region us-east-1 --profile urbont \
  | docker login --username AWS --password-stdin "${REPO%/*}"

docker build --platform linux/arm64 -t "$REPO:latest" .
```

Comprueba qué se horneó **antes** de subirlo. Si `ALLOWED_ORIGIN` sale vacío o
`SUPABASE_URL` apunta a desarrollo, reconstruye:

```bash
docker run --rm --entrypoint sh "$REPO:latest" -c \
  'grep -E "^(NODE_ENV|ALLOWED_ORIGIN|SUPABASE_URL)=" /app/.env'

docker push "$REPO:latest"
```

---

## Paso 9 — Cluster y servicio

### Rol de servicio de ECS

En una cuenta que nunca ha usado ECS falta el rol `AWSServiceRoleForECS`, y
`create-cluster` falla con *"Unable to assume the service linked role"*. Se crea
una sola vez por cuenta:

```bash
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com \
  --profile urbont
```

`InvalidInput: has been taken already` significa que ya existía — sigue.

### Cluster

```bash
aws ecs create-cluster --cluster-name urbont --capacity-providers FARGATE \
  --region us-east-1 --profile urbont

aws ecs describe-clusters --clusters urbont \
  --query 'clusters[0].{name:clusterName,status:status}' \
  --region us-east-1 --profile urbont
```

**Debe decir `ACTIVE` antes de seguir.** Si el `create-cluster` falla y sigues
adelante, el `create-service` responde `ClusterNotFoundException`, que despista
sobre la causa real.

### Servicio

Comprueba las cuatro variables — si vienes de otra terminal estarán vacías:

```bash
echo "SUBNET_A=$SUBNET_A  SUBNET_B=$SUBNET_B  SG_TASK=$SG_TASK  TG_ARN=$TG_ARN"
```

Para recuperarlas, ve a *Si algo falla* al final del paso.

```bash
aws ecs create-service \
  --cluster urbont \
  --service-name urbont-api \
  --task-definition urbont-api \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$SG_TASK],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=api,containerPort=8080" \
  --health-check-grace-period-seconds 90 \
  --deployment-configuration 'minimumHealthyPercent=100,maximumPercent=200' \
  --region us-east-1 --profile urbont
```

Comillas **dobles** en `--network-configuration` y `--load-balancers`: con
simples el shell no expande las variables.

`minimumHealthyPercent=100` + `maximumPercent=200` es despliegue sin caída.
`health-check-grace-period-seconds=90` evita que ECS mate el task durante el
arranque lento.

```bash
aws ecs describe-services --cluster urbont --services urbont-api \
  --query 'services[0].deployments[*].{Status:status,Running:runningCount,Pending:pendingCount}' \
  --output table --region us-east-1 --profile urbont
```

### Si algo falla

Para recuperar las variables desde los recursos ya creados:

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text \
  --region us-east-1 --profile urbont)

SG_TASK=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values=urbont-task-sg Name=vpc-id,Values=$VPC \
  --query 'SecurityGroups[0].GroupId' --output text \
  --region us-east-1 --profile urbont)

TG_ARN=$(aws elbv2 describe-target-groups --names urbont-api-tg \
  --query 'TargetGroups[0].TargetGroupArn' --output text \
  --region us-east-1 --profile urbont)

read SUBNET_A SUBNET_B <<< $(aws elbv2 describe-load-balancers --names urbont-api-alb \
  --query 'LoadBalancers[0].AvailabilityZones[*].SubnetId' --output text \
  --region us-east-1 --profile urbont)

echo "SUBNET_A=$SUBNET_A  SUBNET_B=$SUBNET_B  SG_TASK=$SG_TASK  TG_ARN=$TG_ARN"
```

Las subnets salen del propio ALB, así que son con seguridad las dos que ya
usaste en el Paso 5.

---

## Paso 10 — DNS

Registro **A de tipo alias** apuntando al ALB. Captura sus dos datos:

```bash
read ALB_DNS ALB_ZONE <<< $(aws elbv2 describe-load-balancers --names urbont-api-alb \
  --query 'LoadBalancers[0].[DNSName,CanonicalHostedZoneId]' --output text \
  --region us-east-1 --profile urbont)

echo "ALB_DNS=$ALB_DNS  ALB_ZONE=$ALB_ZONE"
```

**Si `ALB_ZONE` sale vacío**, no sigas: el heredoc de más abajo generará
`"HostedZoneId": ""` sin avisar, y el `change-resource-record-sets` fallará
recién al final con un mensaje que no menciona el JSON para nada
(`argument --hosted-zone-id: expected one argument`, porque en ese punto
también suele estar vacío `$ZONE_ID`). Repite el `read` de arriba, o pon el
valor fijo del alias de ALB en `us-east-1` a mano:

```bash
ALB_ZONE=Z35SXDOTRQ7X7K   # fijo por región, tabla: https://docs.aws.amazon.com/general/latest/gr/elb.html
```

Y el ID de la zona de tu dominio. Viene con el prefijo `/hostedzone/`; solo
necesitas la parte final:

```bash
aws route53 list-hosted-zones \
  --query 'HostedZones[].{name:Name,id:Id}' --output table --profile urbont

ZONE_ID=Z0123ABCDEFGH
```

**Antes de generar el JSON, comprueba las tres variables en la misma
terminal** — si vienes de una sesión anterior (otra pestaña, otro día)
estarán vacías y el error solo aparece al final, no aquí:

```bash
echo "ALB_DNS=$ALB_DNS  ALB_ZONE=$ALB_ZONE  ZONE_ID=$ZONE_ID"
```

El JSON se genera con un heredoc para que el shell expanda las variables — entre
comillas simples no se expandirían, y en zsh un `<ALB_ZONE>` sin sustituir se
interpreta como redirección de entrada y da `no such file or directory`:

```bash
cat > /tmp/dns.json <<JSON
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "api.urbont.com",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "$ALB_ZONE",
        "DNSName": "$ALB_DNS",
        "EvaluateTargetHealth": true
      }
    }
  }]
}
JSON

cat /tmp/dns.json    # comprueba que no queda ninguna variable sin expandir NI vacía

aws route53 change-resource-record-sets --hosted-zone-id $ZONE_ID \
  --change-batch file:///tmp/dns.json --profile urbont
```

`$ZONE_ID` es la zona de tu dominio; `$ALB_ZONE` es la del balanceador, un valor
fijo de AWS por región. Son distintas y se confunden con facilidad.

Con Cloudflare u otro proveedor, un CNAME al valor de `$ALB_DNS` sirve igual,
salvo en el ápex del dominio.

---

## Verificación

Los cuatro últimos fallan en silencio si no los pruebas.

```bash
# 1. Health check — debe dar checks.db: "ok"
curl -s https://api.urbont.com/api/healthz | jq

# 2. WebSocket — debe abrir y dar un frame 0{"sid":...}
#    Dejalo 2 minutos sin trafico para validar el idle timeout
npx wscat -c 'wss://api.urbont.com/socket.io/?EIO=4&transport=websocket'

# 3. CORS — sin capacitor://localhost la APK deja de funcionar
curl -sI -X OPTIONS https://api.urbont.com/api/config \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: GET' | grep -i access-control

# 4. Logs — busca "URBONT API + Socket.IO server started"
aws logs tail /ecs/urbont-api --follow --since 10m \
  --region us-east-1 --profile urbont
```

**5. Webhook de Stripe.** Actualiza la URL en el dashboard y dispara un evento de
prueba. El `express.raw` de [`server.ts:421`](../server.ts#L421) es sensible a
cualquier transformación del body: una firma inválida significa pagos que no se
registran.

---

## Operación

### Desplegar una versión nueva

Igual para un cambio de código que para rotar un secreto: en ambos casos hay que
reconstruir, porque el `.env` está dentro de la imagen.

```bash
REPO=<ACCT>.dkr.ecr.us-east-1.amazonaws.com/urbont-api

grep -E '^(ALLOWED_ORIGIN|SUPABASE_URL)=' .env

aws ecr get-login-password --region us-east-1 --profile urbont \
  | docker login --username AWS --password-stdin "${REPO%/*}"

docker build --platform linux/arm64 -t "$REPO:latest" .
docker push "$REPO:latest"

aws ecs update-service --cluster urbont --service urbont-api \
  --force-new-deployment --region us-east-1 --profile urbont

aws ecs describe-services --cluster urbont --services urbont-api \
  --query 'services[0].deployments[*].{Status:status,Running:runningCount,Pending:pendingCount}' \
  --output table --region us-east-1 --profile urbont
```

No hace falta registrar revisión nueva del task definition mientras no cambies
`taskdef.json`. Si tocas `environment`, `cpu`, `memory` o el health check, sí:
regístrala y pásala con `--task-definition`.

### Rollback

Al empujar siempre a `:latest`, la imagen anterior sigue en ECR sin etiqueta,
identificada por su digest, hasta que la política del Paso 1 la expire:

```bash
aws ecr describe-images --repository-name urbont-api \
  --query 'sort_by(imageDetails,&imagePushedAt)[*].{digest:imageDigest,tags:imageTags,pushed:imagePushedAt}' \
  --output table --region us-east-1 --profile urbont
```

Apunta el `image` del `taskdef.json` a `urbont-api@sha256:...`, registra la
revisión y despliégala. Devuélvelo a `:latest` después, o el siguiente despliegue
no surtirá efecto.

Alternativa sin digests: `git checkout` del commit bueno, reconstruir y empujar.

Si el problema fue de configuración y no de código, vuelve a la revisión anterior
del task definition:

```bash
aws ecs list-task-definitions --family-prefix urbont-api --sort DESC \
  --region us-east-1 --profile urbont

aws ecs update-service --cluster urbont --service urbont-api \
  --task-definition urbont-api:<N-1> --force-new-deployment \
  --region us-east-1 --profile urbont
```

### Cambiar una variable

| Variable | Dónde vive | Qué hacer |
|---|---|---|
| `ALLOWED_ORIGIN`, `NODE_ENV`, `PORT`, `CRON_ENABLED` | Task definition | Editar `taskdef.json`, registrar revisión, `update-service --task-definition` |
| Los secretos | `.env` de la imagen | Reconstruir y redesplegar |

Un `--force-new-deployment` sobre la misma imagen no cambia ningún secreto.

### Diagnosticar un task que no arranca

```bash
aws ecs describe-services --cluster urbont --services urbont-api \
  --query 'services[0].events[:10]' \
  --region us-east-1 --profile urbont

aws ecs describe-tasks --cluster urbont \
  --tasks $(aws ecs list-tasks --cluster urbont --service-name urbont-api \
    --query 'taskArns[0]' --output text --region us-east-1 --profile urbont) \
  --query 'tasks[0].{last:lastStatus,stopped:stoppedReason,containers:containers[].reason}' \
  --region us-east-1 --profile urbont
```

---

## Costes

Mensuales en `us-east-1`, sin transferencia de datos.

| Componente | 1 task | 2 tasks |
|---|---|---|
| Fargate ARM64 (0.5 vCPU / 1 GB) | $14 | $29 |
| Application Load Balancer | $18 | $18 |
| ElastiCache `cache.t4g.micro` | — | $10 |
| ECR + CloudWatch Logs | ~$3 | ~$4 |
| **Total** | **~$35** | **~$61** |

El ALB cuesta más que el cómputo y es fijo. Un NAT Gateway añadiría $33/mes sin
aportar nada (ver Paso 3). Cloud Run con `min-instances=1` está en ~$15-25.

---

# Anexo — Escalar a 2+ tasks

No hace falta para el despliegue inicial.

## Requisitos previos, en este orden

Escalar antes de completar 1 y 2 es peor que no escalar: los fallos son
intermitentes y no dejan error en los logs.

| # | Arreglo | Por qué bloquea |
|---|---|---|
| 1 | Guarda `CRON_ENABLED` + servicio de cron aparte | 14 jobs duplicados. El peor: `staleRideWatchdog` reasigna el mismo viaje a dos conductores |
| 2 | `driverSocketMap` → rooms `driver:${driverId}` | El despacho no cruza instancias |
| 3 | Rate limiter a `rate-limit-redis` | El límite se multiplica por el número de tasks |
| 4 | Timers de reasignación a estado persistente | Opcional: ya pasa hoy con 1 task |

Detalle job por job en [`CRON_JOBS.md`](CRON_JOBS.md).

## 1. Redis

**Es necesario pero no suficiente.** El adapter de Redis sincroniza rooms y
broadcasts. El despacho de viajes no usa rooms: emite al `socketId` sacado de
`driverSocketMap`
([`socketService.ts:857-878`](../server/services/socketService.ts#L857-L878)), un
`Map` en memoria de cada proceso. Añadir Redis sin hacer antes el arreglo 2 da el
peor escenario: todo parece correcto y el conductor de la otra instancia sigue sin
recibir la oferta.

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id urbont-redis \
  --engine valkey \
  --cache-node-type cache.t4g.micro \
  --num-cache-nodes 1 \
  --security-group-ids <SG_TASK> \
  --region us-east-1 --profile urbont
```

~$9-12/mes. Añade `REDIS_URL` al `.env`, reconstruye y redespliega; el adapter se
activa solo ([`socketService.ts:15-32`](../server/services/socketService.ts#L15-L32)).
Upstash Redis sale más barato y funciona igual con `rediss://`.

## 2. Servicio de cron aparte

Un único ejecutor resuelve los tres problemas críticos sin refactorizar 14 jobs.

```ts
if (process.env.CRON_ENABLED !== 'false') startCronJobs();
```

```bash
aws ecs create-service \
  --cluster urbont --service-name urbont-cron \
  --task-definition urbont-api \
  --desired-count 1 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A],securityGroups=[$SG_TASK],assignPublicIp=ENABLED}" \
  --region us-east-1 --profile urbont
```

| Servicio | `CRON_ENABLED` | En el ALB | `desiredCount` |
|---|---|---|---|
| `urbont-api` | `false` | Sí | 2+ |
| `urbont-cron` | `true` | No | **1 — nunca más** |

Con dos servicios, cada versión nueva exige dos `update-service`. Es fácil dejar
el de cron con código viejo durante semanas.

## 3. Subir el contador

```bash
aws ecs update-service --cluster urbont --service urbont-api \
  --desired-count 2 --region us-east-1 --profile urbont
```

## Los despliegues rolling solapan dos tasks

Aplica aunque te quedes en 1 task. Con `maximumPercent=200`, ECS levanta el nuevo
y espera a que pase el health check antes de retirar el viejo: 60-120 segundos con
dos procesos corriendo cron.

No es hipotético: [`cron.ts:611`](../server/jobs/cron.ts#L611) y
[`cron.ts:644`](../server/jobs/cron.ts#L644) ejecutan dos jobs **al arrancar**, así
que cada despliegue garantiza una ejecución concurrente. El primero es seguro; el
segundo duplica el despacho de viajes programados que caigan en esa ventana.

Ya pasa hoy en Cloud Run, que también solapa revisiones. No es una regresión.

---

*Documento del equipo técnico de URBONT · Septiembre 2026*
