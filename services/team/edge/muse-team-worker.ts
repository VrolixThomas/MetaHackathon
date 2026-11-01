import { startEdge } from "./runtime";
import { createTeamWorkerHandler } from "./worker";

startEdge(createTeamWorkerHandler, true);
