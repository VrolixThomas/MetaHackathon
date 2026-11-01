import { startEdge } from "./runtime";
import { createTeamWebhookHandler } from "./webhook";

startEdge(createTeamWebhookHandler);
