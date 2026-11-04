/** R-2021: the three OPTIONAL phone-flow fields (buy-intent.ts), spread into a route's zod object. */
import { z } from "zod";
import { BUY_INTENTS, DOMAIN_MODES, MIGRATION_SOURCES } from "./buy-intent";

export const buyIntentFields = {
  intent: z.enum(BUY_INTENTS).optional(),
  domainMode: z.enum(DOMAIN_MODES).optional(),
  migrationSource: z.enum(MIGRATION_SOURCES).optional(),
};
