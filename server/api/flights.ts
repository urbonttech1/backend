import { Router, Request, Response } from 'express';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const flightsRouter = Router();

const AVIATION_KEY = process.env.AVIATION_STACK_KEY || '';

interface FlightResult {
  flightNumber: string;
  airline: string;
  status: string;
  scheduledArrival: string | null;
  estimatedArrival: string | null;
  actualArrival:    string | null;
  departureAirport: string;
  arrivalAirport:   string;
  terminal:         string | null;
  gate:             string | null;
  delayMinutes:     number;
}

// ── GET /api/flights/lookup?flight=AA1234&type=arrival ───────────────────────
flightsRouter.get('/lookup', async (req: Request, res: Response) => {
  const { flight, type = 'arrival' } = req.query as { flight?: string; type?: string };
  if (!flight) return res.status(400).json({ error: 'flight param required (e.g. AA1234)' });

  if (!AVIATION_KEY) {
    return res.status(503).json({
      error: 'Flight lookup not configured',
      hint: 'Set AVIATION_STACK_KEY in environment variables',
    });
  }

  try {
    const iata   = flight.toUpperCase().replace(/\s/g, '');
    const url    = `https://api.aviationstack.com/v1/flights?access_key=${AVIATION_KEY}&flight_iata=${iata}&limit=1`;
    const raw    = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!raw.ok) return res.status(502).json({ error: 'Aviation API error', status: raw.status });

    type FlightEndpoint = { scheduled?: string; estimated?: string; actual?: string; delay?: number | string; terminal?: string; gate?: string; airport?: string; iata?: string };
    type FlightRecord = { arrival?: FlightEndpoint; departure?: FlightEndpoint; airline?: { name?: string }; flight_status?: string };
    const json   = await raw.json() as { data?: FlightRecord[] };
    const data   = json?.data;
    if (!data?.length) return res.status(404).json({ error: 'Flight not found', flight: iata });

    const f  = data[0];
    const arrival = f.arrival;
    const departure = f.departure;

    const scheduled = arrival?.scheduled || null;
    const estimated = arrival?.estimated || null;
    const actual    = arrival?.actual    || null;
    const delayMin  = arrival?.delay     || 0;

    const result: FlightResult = {
      flightNumber:     iata,
      airline:          f.airline?.name || 'Unknown',
      status:           f.flight_status || 'unknown',
      scheduledArrival: scheduled,
      estimatedArrival: estimated,
      actualArrival:    actual,
      departureAirport: departure?.iata || departure?.airport || '—',
      arrivalAirport:   arrival?.iata   || arrival?.airport   || '—',
      terminal:         arrival?.terminal || null,
      gate:             arrival?.gate     || null,
      delayMinutes:     typeof delayMin === 'number' ? delayMin : parseInt(delayMin || '0', 10),
    };

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Flight lookup failed' });
  }
});

// ── GET /api/flights/status — Check if API is configured ────────────────────
flightsRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: !!AVIATION_KEY });
});
