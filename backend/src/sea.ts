import fsp from "node:fs/promises";
import path from "node:path";
import { getAsset, isSea } from "node:sea";
import { x as untar } from "tar";
import { DATA_DIR, VERSION } from "./config.js";

/** True when running as the single-file Windows app instead of from source or a container. */
export const IS_PACKED_APP = isSea();

/**
 * The packed app carries the web interface inside itself as a tar.gz. Unpack it
 * once per version next to the data, and return the folder to serve.
 */
export async function unpackUi(): Promise<string | undefined> {
  if (!isSea()) return undefined;
  const dir = path.join(DATA_DIR, "ui", VERSION);
  try {
    await fsp.access(path.join(dir, "index.html"));
    return dir;
  } catch {
    /* not unpacked yet */
  }
  await fsp.mkdir(dir, { recursive: true });
  const archive = path.join(dir, "ui.tgz");
  await fsp.writeFile(archive, Buffer.from(getAsset("ui.tgz")));
  await untar({ file: archive, cwd: dir });
  await fsp.rm(archive, { force: true });
  return dir;
}
