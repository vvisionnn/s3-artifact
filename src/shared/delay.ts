/** Resolves after `ms` milliseconds. Injected wherever code waits, so tests never sleep. */
export const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
