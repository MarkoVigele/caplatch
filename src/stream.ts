type LastChunk = Record<string, unknown> | null;

/**
 * Bytes already queued for the caller stay queued. Settlement waits until
 * the upstream stream ends, or until it fails.
 */
export function forwardSse(
  source: ReadableStream<Uint8Array>,
  onEnd: (usage: unknown, failed: boolean) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  void reader.closed.catch(() => undefined);
  const decoder = new TextDecoder();
  let buffer = "";
  let lastChunk: LastChunk = null;
  let claimed = false;

  function claim(): boolean {
    if (claimed) {
      return false;
    }
    claimed = true;
    return true;
  }

  function note(event: string): void {
    const data = dataPayload(event);
    if (data === null || data === "[DONE]") {
      return;
    }
    lastChunk = parseObject(data);
  }

  function absorb(final: boolean): void {
    while (true) {
      const split = nextEvent(buffer);
      if (!split) {
        break;
      }
      buffer = split.rest;
      note(split.event);
    }
    if (final && buffer.length > 0) {
      note(buffer);
      buffer = "";
    }
  }

  async function finish(failed: boolean): Promise<void> {
    if (!claim()) {
      return;
    }
    if (failed) {
      await onEnd(undefined, true);
      return;
    }
    buffer += decoder.decode();
    absorb(true);
    const usage = lastChunk ? lastChunk.usage : undefined;
    await onEnd(usage, false);
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        await finish(true);
        throw new Error("upstream stream failed");
      }
      if (next.done) {
        try {
          await finish(false);
        } catch {
          throw new Error("upstream stream failed");
        }
        controller.close();
        return;
      }
      try {
        controller.enqueue(next.value);
        buffer += decoder.decode(next.value, { stream: true });
        absorb(false);
      } catch {
        await finish(true);
        throw new Error("upstream stream failed");
      }
    },
    async cancel() {
      await finish(true);
      try {
        await reader.cancel();
      } catch {
        // The caller has already left. The hold is settled above.
      }
    },
  });
}

export function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function nextEvent(buffer: string): { event: string; rest: string } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match) {
    return null;
  }
  return {
    event: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

function dataPayload(event: string): string | null {
  const lines = event.split(/\r?\n/);
  const data: string[] = [];
  let saw = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    saw = true;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  if (!saw) {
    return null;
  }
  return data.join("\n").trim();
}

function parseObject(data: string): LastChunk {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
