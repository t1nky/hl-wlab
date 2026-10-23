/** A real macrotask, without nested setTimeout's browser clamp. */
export function yieldScan(): Promise<void> {
  // scheduler.yield continuations can outrank inbound worker messages for the
  // entire scan. Posted MessageChannel tasks let cancel/trace messages run too.
  if (typeof MessageChannel === 'undefined')
    return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}
