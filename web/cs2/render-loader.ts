import { ImageBitmapLoader, LoaderUtils, type LoadingManager } from 'three';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RenderResources } from './render-resources';

/** Three's pinned ImageBitmapLoader does not accept AbortSignal. Retain its image
 * orientation/color-space options while cancelling fetches and closing late decodes. */
class RenderBitmapLoader extends ImageBitmapLoader {
  private signal: AbortSignal;
  private resources: RenderResources;
  constructor(manager: LoadingManager, signal: AbortSignal, resources: RenderResources) {
    super(manager);
    this.signal = signal;
    this.resources = resources;
  }
  override load(
    url: string,
    onLoad?: (bitmap: ImageBitmap) => void,
    _progress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ) {
    const resolved = this.manager.resolveURL(this.path + url);
    this.manager.itemStart(resolved);
    void (async () => {
      try {
        this.signal.throwIfAborted();
        const response = await fetch(resolved, {
          signal: this.signal,
          headers: this.requestHeader,
          credentials: this.crossOrigin === 'anonymous' ? 'same-origin' : 'include',
        });
        if (!response.ok) throw Error(`Missing render image (${response.status})`);
        const blob = await response.blob();
        this.signal.throwIfAborted();
        const bitmap = await createImageBitmap(blob, {
          ...this.options,
          colorSpaceConversion: 'none',
        });
        this.resources.bitmap(bitmap);
        this.signal.throwIfAborted();
        onLoad?.(bitmap);
      } catch (error) {
        onError?.(error);
        this.manager.itemError(resolved);
      } finally {
        this.manager.itemEnd(resolved);
      }
    })();
  }
}

export function trackRenderParser(
  parser: GLTFParser,
  manager: LoadingManager,
  signal: AbortSignal,
  resources: RenderResources,
) {
  const dependency = parser.getDependency.bind(parser);
  parser.getDependency = (type, index) =>
    dependency(type, index).then((value) => {
      if (type === 'texture') resources.texture(value);
      else if (type === 'material') resources.material(value);
      else if (type === 'mesh') resources.object(value);
      return value;
    });
  const loader = parser.textureLoader;
  if (loader instanceof ImageBitmapLoader) {
    parser.textureLoader = new RenderBitmapLoader(manager, signal, resources)
      .setCrossOrigin(loader.crossOrigin)
      .setRequestHeader(loader.requestHeader)
      .setOptions(loader.options ?? {});
  }
  const loadBuffer = parser.loadBuffer.bind(parser);
  parser.loadBuffer = async (index) => {
    const definition = parser.json.buffers[index];
    if (definition.uri === undefined) return loadBuffer(index);
    signal.throwIfAborted();
    const url = manager.resolveURL(LoaderUtils.resolveURL(definition.uri, parser.options.path));
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Missing render buffer (${response.status})`);
    return response.arrayBuffer();
  };
}

/** Stop awaiting a parser immediately on abort; its dependency hooks still clean up
 * late results. Native createImageBitmap itself cannot be interrupted. */
export function abortableRender<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
