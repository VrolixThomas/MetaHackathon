import { createTeamApiHandler } from "./api";
import { startEdge } from "./runtime";

startEdge(createTeamApiHandler);
