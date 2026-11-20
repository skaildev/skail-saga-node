/** One thing that happened in a run, as the commands report it. `step` is a short tag the page uses. */
export interface TimelineEntry {
  runId: string;
  at: string;
  text: string;
  step: string | null;
}

/**
 * What the commands did, in order: printed to the console and kept in memory for the page. In your system this would
 * be your own logs or database; skail keeps the real history of every run in the Monitor.
 */
export class Timeline {
  private readonly entries: TimelineEntry[] = [];

  add(runId: string, text: string, step: string | null = null): void {
    this.entries.push({ runId, at: new Date().toISOString(), text, step });
    console.log(`[${runId.slice(0, 8)}] ${text}`);
  }

  all(): TimelineEntry[] {
    return [...this.entries];
  }
}
