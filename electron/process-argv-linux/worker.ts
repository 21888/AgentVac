/** Fixed packaged child entry. No raw errors, arguments, environment or stderr output. */
import { linuxArgumentCollector } from "./collector.js";
import {
  HOST_LIMITS,
  parseRequestFrame,
  type ObservationRequest,
} from "./protocol.js";

const input = Buffer.alloc(HOST_LIMITS.requestBytes);
let used = 0,
  received = 0,
  started = false,
  stopped = false;
let lastPing = performance.now();
const controller = new AbortController();
function stop() {
  if (stopped) return;
  stopped = true;
  controller.abort();
  input.fill(0);
  process.exit(0);
}
// The production collector never synchronously blocks on proc. These remain
// runnable while its isolated libuv read is pending, including parent EOF.
const watchdog = setInterval(() => {
  if (performance.now() - lastPing > 2000) stop();
}, 250);
const hardDeadline = setTimeout(stop, HOST_LIMITS.deadlineMs + 250);
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdout.on("error", stop);
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);

function write(value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > HOST_LIMITS.frameBytes) {
    bytes.fill(0);
    stop();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    process.stdout.write(bytes, () => {
      bytes.fill(0);
      resolve();
    });
  });
}

async function collect(requests: ObservationRequest[]) {
  for (let index = 0; index < requests.length && !stopped; index++) {
    const result = await linuxArgumentCollector.collect({
      ...requests[index],
      signal: controller.signal,
    });
    if (stopped) return;
    await write({ v: 1, index, result });
  }
  if (!stopped) await write({ v: 1, done: true });
  clearInterval(watchdog);
  clearTimeout(hardDeadline);
  stop();
}

process.stdin.on("data", (chunk: Buffer) => {
  received += chunk.length;
  if (received > HOST_LIMITS.requestBytes + 1024) return stop();
  for (let offset = 0; offset < chunk.length; offset++) {
    const byte = chunk[offset];
    if (byte !== 10) {
      if (used >= (started ? 4 : input.length)) return stop();
      input[used++] = byte;
      continue;
    }
    if (started) {
      if (used !== 4 || !input.subarray(0, 4).equals(Buffer.from("ping")))
        return stop();
      lastPing = performance.now();
      input.fill(0, 0, used);
      used = 0;
    } else {
      const requests = parseRequestFrame(input.subarray(0, used));
      input.fill(0, 0, used);
      used = 0;
      started = true;
      if (!requests) return stop();
      void collect(requests).catch(stop);
    }
  }
});
