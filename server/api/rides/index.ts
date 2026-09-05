import { Router } from "express";
import { registerCreateRoutes } from "./create";
import { registerAcceptRoutes } from "./accept";
import { registerCancelRoutes } from "./cancel";
import { registerCheckinRoutes } from "./checkin";
import { registerStatusRoutes } from "./status";
import { registerValetRoutes } from "./valet";
import { registerStatsRoutes } from "./stats";

export type { PickupDropoff, RideRow, DriverStats } from "./types";
export { getStripe, updateDriverStreak, pinAttemptTracker, errMsg } from "./helpers";

export const rideRouter = Router();

// Mount all modularized route handlers
registerCreateRoutes(rideRouter);
registerAcceptRoutes(rideRouter);
registerCancelRoutes(rideRouter);
registerCheckinRoutes(rideRouter);
registerStatusRoutes(rideRouter);
registerValetRoutes(rideRouter);
registerStatsRoutes(rideRouter);

export default rideRouter;
