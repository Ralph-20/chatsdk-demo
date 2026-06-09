import { helpful } from "./helpful";
import { prReviewer } from "./pr-reviewer";
import { dbAnalyst } from "./db-analyst";
export const agents = { helpful, prReviewer, dbAnalyst } as const;
