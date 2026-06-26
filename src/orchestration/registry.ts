import type { Workflow } from "../workflows/base.js";
import { BookingWorkflow } from "../workflows/booking.js";

/**
 * Site → Workflow registry. The orchestration layer is site-agnostic: it reads
 * `job.site` and looks the workflow up here. Adding a site = one entry.
 */
const WORKFLOWS = new Map<string, () => Workflow>([["booking", () => new BookingWorkflow()]]);

export function registerWorkflow(site: string, factory: () => Workflow): void {
  WORKFLOWS.set(site, factory);
}

export function getWorkflow(site: string): Workflow {
  const factory = WORKFLOWS.get(site);
  if (!factory) throw new Error(`no workflow registered for site "${site}"`);
  return factory();
}

export function registeredSites(): string[] {
  return [...WORKFLOWS.keys()];
}
