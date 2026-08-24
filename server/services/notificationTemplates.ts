/**
 * URBONT Notification Templates
 * Uber-style: short titles, action-oriented body, deep-link data.
 * All push notifications go through these templates for consistency.
 */

export interface PushTemplate {
  title: string;
  body: string;
  data?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Passenger
// ─────────────────────────────────────────────────────────────────────────────
export const passengerNotif = {
  welcome(firstName?: string): PushTemplate {
    return {
      title: "You're in!",
      body: `${firstName ? `${firstName}, ` : ''}your premium chauffeur is one tap away. Book your first ride now.`,
      data: { type: 'welcome', screen: 'home' },
    };
  },

  rideScheduled(rideId: string): PushTemplate {
    return {
      title: 'Ride booked ✓',
      body: "You're confirmed. We'll assign your chauffeur 30 minutes before pickup.",
      data: { type: 'ride_scheduled', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  rideSearching(rideId: string): PushTemplate {
    return {
      title: 'Finding your chauffeur',
      body: "You're on the list — a driver will confirm any moment now.",
      data: { type: 'ride_searching', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  scheduled24h(rideId: string, timeLabel: string): PushTemplate {
    return {
      title: 'Ride tomorrow',
      body: `Your URBONT ride is set for tomorrow at ${timeLabel}. We've got your chauffeur ready.`,
      data: { type: 'scheduled_reminder_24h', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  scheduled1h(rideId: string, timeLabel: string): PushTemplate {
    return {
      title: 'Ride in 1 hour',
      body: `Head to your pickup point — chauffeur assignment starts shortly. Pickup at ${timeLabel}.`,
      data: { type: 'scheduled_reminder_1h', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  scheduled15min(rideId: string, minutes: number): PushTemplate {
    return {
      title: `Pickup in ${minutes} min`,
      body: "Your reservation is coming up. We're dispatching your chauffeur now.",
      data: { type: 'scheduled_reminder_15m', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  driverConfirmed(rideId: string, driverName?: string): PushTemplate {
    return {
      title: "You're picked up! 🚗",
      body: `${driverName ? driverName : 'Your chauffeur'} accepted your ride and is on the way.`,
      data: { type: 'ride_confirmed', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  driverArrivingSoon(rideId: string, etaMin: number): PushTemplate {
    return {
      title: `${etaMin} min away`,
      body: 'Your chauffeur is almost there — head to the pickup point now.',
      data: { type: 'driver_arriving_soon', ride_id: rideId, eta_min: String(etaMin), screen: 'ride_tracking' },
    };
  },

  driverArrived(rideId: string): PushTemplate {
    return {
      title: 'Your ride is here!',
      body: 'Your chauffeur is waiting at pickup. Head to the vehicle.',
      data: { type: 'driver_arrived', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  rideStarted(rideId: string): PushTemplate {
    return {
      title: "You're on your way",
      body: 'Sit back, relax, and enjoy the ride.',
      data: { type: 'ride_started', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  safetyCheckin(rideId: string): PushTemplate {
    return {
      title: "How's the ride?",
      body: 'Tap here anytime to reach support or alert your emergency contact.',
      data: { type: 'safety_checkin', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  rideCompleted(rideId: string): PushTemplate {
    return {
      title: "You've arrived!",
      body: 'Thanks for riding with URBONT. Rate your experience.',
      data: { type: 'ride_completed', ride_id: rideId, screen: 'ride_summary' },
    };
  },

  rateReminder(rideId: string): PushTemplate {
    return {
      title: 'Rate your chauffeur',
      body: 'Got a second? Your feedback keeps URBONT premium.',
      data: { type: 'rate_reminder', ride_id: rideId, screen: 'ride_summary' },
    };
  },

  driverCancelledReassigning(rideId: string): PushTemplate {
    return {
      title: 'Finding you a new chauffeur',
      body: "Your driver had to cancel — we're on it. Searching now.",
      data: { type: 'driver_cancelled_reassigning', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  rideCancelledNoDriver(rideId: string): PushTemplate {
    return {
      title: 'No chauffeur available',
      body: "We couldn't match a driver this time. You haven't been charged.",
      data: { type: 'no_driver_available', ride_id: rideId, screen: 'home' },
    };
  },

  noShowFee(rideId: string, fee: number): PushTemplate {
    return {
      title: 'Ride cancelled — no-show',
      body: `Your driver waited but couldn't find you. A $${fee.toFixed(2)} no-show fee applies.`,
      data: { type: 'ride_no_show', ride_id: rideId, screen: 'ride_summary' },
    };
  },

  promoApplied(rideId: string, discount: number, code: string): PushTemplate {
    return {
      title: `$${discount.toFixed(2)} saved!`,
      body: `Promo code ${code} is applied. Enjoy the ride.`,
      data: { type: 'promo_applied', ride_id: rideId, screen: 'ride_tracking' },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Driver / Chauffeur
// ─────────────────────────────────────────────────────────────────────────────
export const driverNotif = {
  welcome(firstName?: string): PushTemplate {
    return {
      title: "You're ready to drive!",
      body: `${firstName ? `Welcome, ${firstName}! ` : ''}Go online to start earning on premium ride requests.`,
      data: { type: 'driver_welcome', screen: 'driver_home' },
    };
  },

  newRideRequest(rideId: string, vehicleType: string, address: string): PushTemplate {
    const short = address.length > 55 ? address.slice(0, 52) + '...' : address;
    return {
      title: 'New ride request',
      body: `${vehicleType} — Pickup: ${short}`,
      data: { type: 'new_ride', ride_id: rideId, vehicle_type: vehicleType, screen: 'ride_offer' },
    };
  },

  tripEarnings(rideId: string, earnings: number): PushTemplate {
    return {
      title: 'Trip complete — nice work!',
      body: earnings > 0 ? `You earned $${earnings.toFixed(2)} on this trip.` : 'Trip completed successfully.',
      data: { type: 'trip_earnings', ride_id: rideId, screen: 'driver_earnings' },
    };
  },

  rideCancelledByPassenger(rideId: string): PushTemplate {
    return {
      title: 'Ride cancelled',
      body: 'The passenger cancelled this ride.',
      data: { type: 'ride_cancelled', ride_id: rideId, screen: 'driver_home' },
    };
  },

  tipUpdated(rideId: string, tip: number): PushTemplate {
    return {
      title: 'Tip updated 💰',
      body: `Your passenger bumped their tip to $${tip.toFixed(2)}.`,
      data: { type: 'tip_updated', ride_id: rideId, screen: 'driver_earnings' },
    };
  },

  stopAdded(rideId: string, address: string): PushTemplate {
    return {
      title: 'New stop added',
      body: `Passenger added a stop: ${address}`,
      data: { type: 'stop_added', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  destinationChanged(rideId: string, address: string, fare: number): PushTemplate {
    return {
      title: 'Destination changed',
      body: `New drop-off: ${address}. Updated fare: $${fare.toFixed(2)}`,
      data: { type: 'destination_changed', ride_id: rideId, screen: 'ride_tracking' },
    };
  },

  streakMilestone(days: number, reward?: string): PushTemplate {
    const rewards: Record<number, string> = {
      3:  'Keep the momentum going!',
      5:  'You earned a $10 bonus.',
      7:  'One full week — you earned a $20 bonus!',
      10: 'Amazing consistency — $30 bonus earned.',
      14: 'Two weeks strong — $50 bonus earned!',
      21: 'Three weeks — you are a URBONT Elite driver.',
      30: 'Legendary! 30-day streak — $100 bonus unlocked.',
    };
    const msg = reward ?? rewards[days] ?? 'Keep it up!';
    return {
      title: `${days}-day streak! 🔥`,
      body: `You've driven ${days} days in a row. ${msg}`,
      data: { type: 'streak_milestone', streak: String(days), screen: 'driver_quests' },
    };
  },

  questProgress(questTitle: string, progress: number, target: number, reward: string): PushTemplate {
    return {
      title: 'Quest progress',
      body: `${progress} of ${target} — "${questTitle}". Finish to earn ${reward}.`,
      data: { type: 'quest_progress', screen: 'driver_quests' },
    };
  },

  questComplete(questTitle: string, reward: string): PushTemplate {
    return {
      title: 'Quest complete! 🎉',
      body: `You completed "${questTitle}" and earned ${reward}!`,
      data: { type: 'quest_complete', screen: 'driver_quests' },
    };
  },

  weeklyEarnings(earnings: number, trips: number, weekLabel: string): PushTemplate {
    return {
      title: `$${earnings.toFixed(2)} earned last week`,
      body: `You completed ${trips} trip${trips !== 1 ? 's' : ''} ${weekLabel}. New week, new goals!`,
      data: { type: 'weekly_earnings', screen: 'driver_earnings' },
    };
  },

  surgeActive(multiplier: number): PushTemplate {
    return {
      title: `${multiplier}x surge is on`,
      body: 'High demand near you — go online now and earn significantly more per trip!',
      data: { type: 'surge_active', multiplier: String(multiplier), screen: 'driver_home' },
    };
  },

  surgeEnded(): PushTemplate {
    return {
      title: 'Surge pricing ended',
      body: 'Demand has stabilized. Standard rates are back in effect.',
      data: { type: 'surge_ended', screen: 'driver_home' },
    };
  },

  backToBackBonus(count: number): PushTemplate {
    return {
      title: `${count} rides back-to-back!`,
      body: 'Great run — keep accepting rides to maximize your streak.',
      data: { type: 'back_to_back', count: String(count), screen: 'driver_home' },
    };
  },

  lowRatingWarning(rating: number): PushTemplate {
    return {
      title: 'Rating alert',
      body: `Your current rating is ${rating.toFixed(2)} stars. Stay above 4.5 to keep good standing.`,
      data: { type: 'low_rating_warning', screen: 'driver_profile' },
    };
  },
};
