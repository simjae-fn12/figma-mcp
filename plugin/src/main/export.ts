// Figma exports cannot be cancelled. Deduplicate identical pending jobs and
// return an actionable error instead of waiting for the bridge's 3-minute limit.
const pending = new Map<string, Promise<Uint8Array>>();
export async function withTimeout<T>(job: Promise<T>, label: string, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      job,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} timed out after ${ms / 1000}s. Figma has not completed the export; keep the file active and retry at a smaller scale. No image was substituted.`
              )
            ),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function exportNode(node: SceneNode, settings: ExportSettings): Promise<Uint8Array> {
  if (settings.format === "PNG" || settings.format === "JPG") {
    const scale = settings.constraint?.type === "SCALE" ? settings.constraint.value : 1;
    if (!Number.isFinite(scale) || scale <= 0)
      throw new Error("Export scale must be positive and finite");
    if (Math.ceil(node.width * scale) * Math.ceil(node.height * scale) > 32_000_000) {
      throw new Error(
        "Export exceeds 32 million pixels; use a smaller scale or export child sections."
      );
    }
  }
  const key = `${node.id}:${JSON.stringify(settings)}`;
  let job = pending.get(key);
  if (!job) {
    if (pending.size >= 4)
      throw new Error(
        "Four exports are still pending in Figma. Wait for completion or reopen the plugin."
      );
    job = node.exportAsync(settings).then((bytes) => {
      if (!bytes.length) throw new Error(`Figma returned empty export bytes for ${node.id}`);
      if (bytes.length > 32 * 1024 * 1024)
        throw new Error("Export exceeds the 32 MiB transfer limit");
      return bytes;
    });
    pending.set(key, job);
    void job.then(
      () => pending.delete(key),
      () => pending.delete(key)
    );
  }
  return withTimeout(job, `Export ${node.id}`);
}
