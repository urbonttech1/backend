#!/usr/bin/env bash
#
# Descubre los IDs de los recursos de AWS de urbont-api y los exporta.
#
#   source scripts/aws-env.sh
#
# No guarda nada: consulta AWS por el nombre de cada recurso, así que es
# idempotente y se puede ejecutar en cualquier momento, desde cualquier terminal.
# Durante el despliegue inicial, los recursos que todavía no existen salen como
# "pendiente" y no rompen nada.
#
# Ver docs/AWS_ECS_DEPLOY.md

export AWS_PROFILE=urbont
export AWS_REGION=us-east-1

# Nombres de los recursos — deben coincidir con los del runbook
_ECR_NAME=urbont-api
_ALB_NAME=urbont-api-alb
_TG_NAME=urbont-api-tg
_SG_ALB_NAME=urbont-alb-sg
_SG_TASK_NAME=urbont-task-sg
_DOMAIN=api.urbont.com
export ECS_CLUSTER=urbont
export ECS_SERVICE=urbont-api

# Silencia el error cuando el recurso aún no existe y normaliza el "None" que
# devuelve --output text cuando la consulta no encuentra nada.
_aws() {
  local out
  out=$(aws "$@" 2>/dev/null) || out=""
  [ "$out" = "None" ] && out=""
  printf '%s' "$out"
}

# ── Cuenta y ECR ─────────────────────────────────────────────────────────────
export ACCT=$(_aws sts get-caller-identity --query Account --output text)
if [ -n "$ACCT" ]; then
  export ECR_REPO="${ACCT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${_ECR_NAME}"
else
  export ECR_REPO=""
fi

# ── Red ──────────────────────────────────────────────────────────────────────
export VPC=$(_aws ec2 describe-vpcs \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# La VPC por defecto tiene una subnet por AZ. Ordenamos por AZ y cogemos las dos
# primeras para que la elección sea estable entre ejecuciones.
if [ -n "$VPC" ]; then
  _subnets=$(_aws ec2 describe-subnets \
    --filters Name=vpc-id,Values="$VPC" \
    --query 'sort_by(Subnets,&AvailabilityZone)[:2].SubnetId' --output text)
  export SUBNET_A=$(printf '%s' "$_subnets" | awk '{print $1}')
  export SUBNET_B=$(printf '%s' "$_subnets" | awk '{print $2}')

  export SG_ALB=$(_aws ec2 describe-security-groups \
    --filters Name=group-name,Values="$_SG_ALB_NAME" Name=vpc-id,Values="$VPC" \
    --query 'SecurityGroups[0].GroupId' --output text)

  export SG_TASK=$(_aws ec2 describe-security-groups \
    --filters Name=group-name,Values="$_SG_TASK_NAME" Name=vpc-id,Values="$VPC" \
    --query 'SecurityGroups[0].GroupId' --output text)
fi

# ── Certificado ──────────────────────────────────────────────────────────────
export CERT_ARN=$(_aws acm list-certificates \
  --query "CertificateSummaryList[?DomainName=='${_DOMAIN}'].CertificateArn | [0]" \
  --output text)

# ── ALB y target group ───────────────────────────────────────────────────────
_alb=$(_aws elbv2 describe-load-balancers --names "$_ALB_NAME" \
  --query 'LoadBalancers[0].[LoadBalancerArn,DNSName,CanonicalHostedZoneId]' \
  --output text)
export ALB_ARN=$(printf '%s' "$_alb" | awk '{print $1}')
export ALB_DNS=$(printf '%s' "$_alb" | awk '{print $2}')
export ALB_ZONE=$(printf '%s' "$_alb" | awk '{print $3}')

export TG_ARN=$(_aws elbv2 describe-target-groups --names "$_TG_NAME" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# ── Resumen ──────────────────────────────────────────────────────────────────
_row() {
  if [ -n "$2" ]; then printf '  \033[32m✓\033[0m %-12s %s\n' "$1" "$2"
  else                 printf '  \033[33m·\033[0m %-12s %s\n' "$1" "pendiente"; fi
}

echo "urbont · $AWS_PROFILE · $AWS_REGION"
_row ACCT      "$ACCT"
_row VPC       "$VPC"
_row SUBNET_A  "$SUBNET_A"
_row SUBNET_B  "$SUBNET_B"
_row SG_ALB    "$SG_ALB"
_row SG_TASK   "$SG_TASK"
_row CERT_ARN  "$CERT_ARN"
_row ALB_ARN   "$ALB_ARN"
_row TG_ARN    "$TG_ARN"
_row ECR_REPO  "$ECR_REPO"

unset -f _aws _row
unset _subnets _alb _ECR_NAME _ALB_NAME _TG_NAME _SG_ALB_NAME _SG_TASK_NAME _DOMAIN
