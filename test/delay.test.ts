import { expect, test } from "bun:test";
import { delay } from "../src/shared/delay.ts";

test("delay resolves after the timer fires", async () => {
	await expect(delay(0)).resolves.toBeUndefined();
});
