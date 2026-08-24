import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function validate(schema: z.ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation error',
        details: result.error.issues.map(issue => ({
          field: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: z.ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error: 'Query parameter validation error',
        details: result.error.issues.map(issue => ({
          field: issue.path.join('.') || 'query',
          message: issue.message,
        })),
      });
      return;
    }
    req.query = result.data as unknown as Request['query'];
    next();
  };
}

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{7,14}$/, 'Invalid phone number. Must be E.164 format e.g. +13051234567');

const latSchema = z.coerce.number().min(-90, 'Latitude min -90').max(90, 'Latitude max 90');
const lngSchema = z.coerce.number().min(-180, 'Longitude min -180').max(180, 'Longitude max 180');

export const schemas = {
  otpSend: z.object({
    phone: phoneSchema,
  }),

  otpVerify: z.object({
    phone: phoneSchema,
    code: z.string().length(6, 'OTP must be 6 digits').regex(/^\d+$/, 'OTP must be numeric'),
  }),

  locationUpdate: z.object({
    lat: latSchema,
    lng: lngSchema,
    // FIX: these used to default to 0 whenever the device omitted a reading
    // (e.g. GPS briefly can't compute heading/speed while stationary), which
    // made the passenger's map arrow visibly snap/reset. `.nullable()` lets a
    // missing/null reading pass through so the DB layer can preserve the last
    // known value instead of overwriting it with a fake 0.
    heading: z.coerce.number().min(0).max(360).nullable().optional(),
    speed: z.coerce.number().min(0).nullable().optional(),
  }),

  driverStatus: z.object({
    is_online: z.boolean(),
  }),

  nearbyQuery: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusKm: z.coerce.number().min(0.1).max(100).default(10),
  }),

  createRide: z
    .object({
      vehicleType: z.string().min(1).optional(),
      vehicle_type: z.string().min(1).optional(),
      pickup: z.union([
        z.string().min(1),
        z
          .object({
            address: z.string(),
            lat: z.number().optional(),
            lng: z.number().optional(),
          })
          .passthrough(),
      ]),
      dropoff: z
        .union([
          z.string().min(1),
          z
            .object({
              address: z.string(),
              lat: z.number().optional(),
              lng: z.number().optional(),
            })
            .passthrough(),
        ])
        .optional(),
      fare: z.number().positive().optional(),
      distance: z.number().positive().optional(),
      durationMinutes: z.number().positive().optional(),
      duration_minutes: z.number().positive().optional(),
      paymentMethod: z.string().optional(),
      payment_method: z.string().optional(),
      notes: z.string().max(500).optional().nullable(),
      scheduled_at: z.string().datetime({ offset: true }).optional().nullable(),
      scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
      flightNumber: z.string().max(20).optional().nullable(),
      airline: z.string().max(100).optional().nullable(),
      airportMode: z.string().optional().nullable(),
    })
    .refine(d => d.vehicleType || d.vehicle_type, {
      message: 'vehicleType is required',
      path: ['vehicleType'],
    }),

  onboardUser: z.object({
    role: z.enum(['passenger', 'driver', 'concierge']),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional().nullable(),
    businessName: z.string().max(200).optional(),
    contactPerson: z.string().max(200).optional(),
  }),

  updateProfile: z
    .object({
      first_name: z.string().max(100).optional(),
      last_name: z.string().max(100).optional(),
      email: z.string().email().optional().nullable(),
      avatar_url: z.string().url().optional(),
      vehicle: z.object({}).passthrough().optional(),
      operating_city: z.string().max(100).optional(),
    })
    .strip(),

  createPaymentIntent: z.object({
    amount: z.number().positive('Amount must be positive'),
    currency: z.string().length(3).default('usd'),
    rideId: z.string().uuid().optional(),
  }),

  submitFeedback: z.object({
    rideId: z.string().uuid().optional(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(1000).optional(),
    category: z.string().optional(),
  }),
};
