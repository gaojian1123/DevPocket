import { acquireEmulatorLease } from "../../emulator-resources.mjs";
import { spawnOwnedCommand } from "../../process.mjs";

let lease;
const cancellation = new AbortController();
process.on("message", async (message) => {
  try {
    if (message.type === "acquire") {
      lease = await acquireEmulatorLease({
        ...message.options, signal: cancellation.signal,
        onWaiting: (status) => process.send({ type: "waiting", ...status }),
      });
      process.send({ type: "acquired", id: lease.id, ports: lease.ports });
    } else if (message.type === "handoff") {
      await lease.handoff();
      process.send({ type: "handed-off" });
    } else if (message.type === "release") {
      await lease.release();
      process.send({ type: "released" }, () => process.exit(0));
    } else if (message.type === "cancel") {
      cancellation.abort();
    } else if (message.type === "prepare") {
      const job = spawnOwnedCommand(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"],
        { timeoutMs: 60_000 });
      job.stdout.once("data", () => process.send({ type: "preparing", pid: job.pid }));
      job.stderr.resume();
    } else throw new Error("Unknown fixture operation.");
  } catch (error) {
    process.send({ type: "error", message: error.message, code: error.code ?? error.name });
  }
});
