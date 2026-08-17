import * as vision from "@mediapipe/tasks-vision";
import type {
  TrackTransformerDestroyOptions,
  VideoTrackTransformer,
  VideoTransformerInitOptions,
} from "@livekit/track-processors";

/**
 * Background blur / replacement that keeps only the *main* person sharp.
 *
 * Why this exists: MediaPipe's selfie-segmentation model marks every human in
 * frame as foreground, so LiveKit's built-in processor deliberately keeps a
 * colleague walking behind you perfectly sharp. There is no model that
 * distinguishes "the person in the meeting" from "someone passing by".
 *
 * So this transformer takes the raw mask and narrows it: it labels the
 * connected shapes in the mask and keeps only the largest one, which is the
 * nearest (and therefore biggest) person. Everything else — furniture, walls
 * and other people — falls into the background and gets blurred or replaced.
 *
 * The cost is a mask read-back from the GPU each frame plus canvas
 * compositing, which is heavier than the built-in WebGL-only path. That is why
 * this sits behind PRIMARY_PERSON_ONLY in lib/features.
 *
 * Known trade-off: two people genuinely sharing one camera will have the
 * smaller of them blurred. That matches Teams, but it is a real limitation
 * rather than an oversight.
 */

export type PrimaryPersonOptions = {
  /** Blur strength in px. Ignored when `imagePath` is set. */
  blurRadius?: number;
  /** Replace the background with this image instead of blurring it. */
  imagePath?: string;
  /** Pass through with no processing at all. */
  disabled?: boolean;
  assetPaths?: { tasksVisionFileSet?: string; modelAssetPath?: string };
} & Record<string, unknown>;

/** Below this share of the frame a blob is noise (a hand, a reflection). */
const MIN_BLOB_FRACTION = 0.004;
/** Blur is computed at 1/N size and scaled back up — see composite(). */
const BLUR_DOWNSCALE = 4;

/* ---- Edge quality (see featheredMask) ---- */
/** The mask is refined at this width before being stretched to the frame. */
const MASK_WORK_WIDTH = 480;
/** Feather radius, in mask-working pixels. */
const MASK_BLUR_PX = 2.5;
/** Push the edge out by a hair so fine hair isn't cut off. */
const MASK_DILATE_PX = 1;
/** Consecutive failed frames before the transform disables itself entirely. */
const MAX_FAILURES = 8;

export class PrimaryPersonTransformer
  implements VideoTrackTransformer<PrimaryPersonOptions>
{
  transformer?: TransformStream;
  options: PrimaryPersonOptions;

  private segmenter?: vision.ImageSegmenter;
  private inputVideo?: HTMLVideoElement;
  /** Output canvas (2D — the base VideoTransformer would claim it for WebGL). */
  private canvas?: OffscreenCanvas | HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** Person cut out of the frame, with alpha. */
  private personCanvas?: OffscreenCanvas | HTMLCanvasElement;
  private personCtx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** The narrowed mask at segmentation resolution. */
  private maskCanvas?: OffscreenCanvas | HTMLCanvasElement;
  private maskCtx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private maskImage?: ImageData;
  private background?: { image: ImageBitmap; path: string };
  /**
   * The background already fitted to the current frame size. It only changes
   * when the image or the frame size does, so it's rendered once and then just
   * copied each frame — cheaper than re-fitting (and re-blurring) every time.
   */
  private bgCanvas?: OffscreenCanvas | HTMLCanvasElement;
  private bgKey = "";
  /** Quarter-size scratch canvas the background blur is computed on. */
  private blurCanvas?: OffscreenCanvas | HTMLCanvasElement;
  private blurCtx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** The feathered mask, rebuilt each frame (no cross-frame state). */
  private softCanvas?: OffscreenCanvas | HTMLCanvasElement;
  private softCtx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  // Reused across frames so the hot path allocates nothing.
  private labels?: Int32Array;
  private queue?: Int32Array;

  /**
   * Consecutive frames where segmentation failed. Past the limit the whole
   * transform gives up for good and passes the camera through untouched.
   *
   * Retrying forever is what turns one broken component into unusable video:
   * a segmenter that starts but can't run produces black or half-composited
   * frames on every single frame. Soft video with no effect is a bad outcome;
   * a black or flickering picture is a worse one.
   */
  private failures = 0;
  private givenUp = false;

  constructor(options: PrimaryPersonOptions) {
    this.options = options;
  }

  async init({ outputCanvas, inputElement }: VideoTransformerInitOptions) {
    if (!(inputElement instanceof HTMLVideoElement)) {
      throw new TypeError("PrimaryPersonTransformer needs a video element");
    }
    this.transformer = new TransformStream({
      transform: (frame: VideoFrame, controller) => this.transform(frame, controller),
    });
    this.inputVideo = inputElement;
    this.canvas = outputCanvas;
    this.ctx = (outputCanvas as HTMLCanvasElement).getContext("2d", {
      alpha: false,
    }) as CanvasRenderingContext2D;
    if (!this.ctx) throw new Error("2D canvas context unavailable");

    const fileSet = await vision.FilesetResolver.forVisionTasks(
      this.options.assetPaths?.tasksVisionFileSet ?? "/mediapipe/wasm"
    );
    this.segmenter = await vision.ImageSegmenter.createFromOptions(fileSet, {
      baseOptions: {
        modelAssetPath:
          this.options.assetPaths?.modelAssetPath ??
          "/mediapipe/selfie_segmenter_landscape.tflite",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });

    if (this.options.imagePath) await this.loadBackground(this.options.imagePath);
  }

  async restart(opts: VideoTransformerInitOptions) {
    this.canvas = opts.outputCanvas;
    this.ctx = (opts.outputCanvas as HTMLCanvasElement).getContext("2d", {
      alpha: false,
    }) as CanvasRenderingContext2D;
    this.inputVideo = opts.inputElement;
  }

  async destroy(_opts?: TrackTransformerDestroyOptions) {
    this.segmenter?.close();
    this.segmenter = undefined;
    this.background?.image.close();
    this.background = undefined;
  }

  async update(options: PrimaryPersonOptions) {
    this.options = { ...this.options, ...options };
    if (options.imagePath && options.imagePath !== this.background?.path) {
      await this.loadBackground(options.imagePath);
    }
    if (!options.imagePath) {
      this.background?.image.close();
      this.background = undefined;
      this.bgCanvas = undefined;
      this.bgKey = "";
    }
  }

  private async loadBackground(path: string) {
    const img = new Image();
    // Only for real URLs. An uploaded background is a data: URL, which is
    // already same-origin — and asking for CORS on one can make the load fail
    // outright, which would look like "my image doesn't work" with no clue why.
    if (!path.startsWith("data:")) img.crossOrigin = "Anonymous";
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () =>
          reject(new Error(`background image failed to load: ${path.slice(0, 60)}`));
        img.src = path;
      });
      this.background?.image.close();
      this.background = { image: await createImageBitmap(img), path };
    } catch (err) {
      // Say so rather than failing mutely. Leaving `background` unset falls
      // back to blur, which is a sane result for a picture we can't read.
      console.error("primary-person: background not applied:", err);
    }
    this.bgCanvas = undefined; // force a re-fit for the new picture
    this.bgKey = "";
  }

  /**
   * Records a failed frame and, past the limit, stops processing for good.
   * A handful in a row means the segmenter isn't going to recover, and the
   * camera must keep working regardless.
   */
  private noteFailure(why: string) {
    this.failures += 1;
    if (this.failures === 1 || this.failures === MAX_FAILURES) {
      console.error(
        `primary-person: frame ${this.failures} failed (${why})` +
          (this.failures >= MAX_FAILURES
            ? " — giving up, passing the camera through unprocessed"
            : "")
      );
    }
    if (this.failures >= MAX_FAILURES) this.givenUp = true;
  }

  /* ------------------------------------------------------------------ */

  transform(frame: VideoFrame, controller: TransformStreamDefaultController) {
    const passthrough = () => controller.enqueue(frame);

    if (
      this.options.disabled ||
      this.givenUp ||
      !this.ctx ||
      !this.canvas ||
      !this.segmenter ||
      frame.codedWidth === 0
    ) {
      passthrough();
      return;
    }

    const w = frame.displayWidth;
    const h = frame.displayHeight;
    // Assigning width/height reallocates and clears the backing store, so only
    // do it when the frame size actually changes.
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    let result: vision.ImageSegmenterResult | undefined;
    try {
      // Synchronous form: we need the mask to composite *this* frame, and the
      // callback form would land after the frame has already been enqueued.
      result = this.segmenter.segmentForVideo(frame, performance.now());
      const mask = result?.categoryMask;
      if (!mask) {
        // A segmenter that runs but returns nothing is broken, not idle.
        this.noteFailure("segmentation returned no mask");
        passthrough();
        return;
      }
      const alpha = this.primaryPersonAlpha(mask);
      // No alpha is legitimate — nobody big enough in frame — so it doesn't
      // count against the failure budget, it just means nothing to cut out.
      if (!alpha) {
        passthrough();
        return;
      }
      this.failures = 0;
      this.composite(frame, alpha, w, h);
      controller.enqueue(
        new VideoFrame(this.canvas as CanvasImageSource, {
          timestamp: frame.timestamp ?? 0,
        })
      );
      frame.close();
    } catch (err) {
      this.noteFailure(String(err));
      passthrough();
      return;
    } finally {
      result?.close();
    }
  }

  /**
   * Turns the raw category mask into an alpha mask containing only the largest
   * person-shape. Returns the mask canvas, sized at segmentation resolution.
   */
  private primaryPersonAlpha(
    mask: vision.MPMask
  ): OffscreenCanvas | HTMLCanvasElement | null {
    const mw = mask.width;
    const mh = mask.height;
    const px = mask.getAsUint8Array(); // 0 = background, non-zero = person
    const n = mw * mh;

    if (!this.labels || this.labels.length < n) {
      this.labels = new Int32Array(n);
      this.queue = new Int32Array(n);
    }
    const labels = this.labels;
    const queue = this.queue!;
    labels.fill(0);

    // Flood-fill each person region, tracking the biggest one. Iterative so a
    // full-frame silhouette can't blow the call stack.
    let best = 0;
    let bestSize = 0;
    let label = 0;
    for (let start = 0; start < n; start++) {
      if (px[start] === 0 || labels[start] !== 0) continue;
      label += 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labels[start] = label;
      let size = 0;
      while (head < tail) {
        const p = queue[head++];
        size += 1;
        const x = p % mw;
        const y = (p - x) / mw;
        // 4-connectivity is enough and half the work of 8.
        if (x > 0 && px[p - 1] !== 0 && labels[p - 1] === 0) {
          labels[p - 1] = label;
          queue[tail++] = p - 1;
        }
        if (x < mw - 1 && px[p + 1] !== 0 && labels[p + 1] === 0) {
          labels[p + 1] = label;
          queue[tail++] = p + 1;
        }
        if (y > 0 && px[p - mw] !== 0 && labels[p - mw] === 0) {
          labels[p - mw] = label;
          queue[tail++] = p - mw;
        }
        if (y < mh - 1 && px[p + mw] !== 0 && labels[p + mw] === 0) {
          labels[p + mw] = label;
          queue[tail++] = p + mw;
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = label;
      }
    }

    if (best === 0 || bestSize < n * MIN_BLOB_FRACTION) return null;

    // Paint the winner into an alpha mask.
    if (!this.maskCanvas || this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) {
      this.maskCanvas = createCanvas(mw, mh);
      this.maskCtx = this.maskCanvas.getContext(
        "2d"
      ) as CanvasRenderingContext2D;
      this.maskImage = this.maskCtx.createImageData(mw, mh);
    }
    const data = this.maskImage!.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const on = labels[i] === best ? 255 : 0;
      data[j] = 255;
      data[j + 1] = 255;
      data[j + 2] = 255;
      data[j + 3] = on;
    }
    this.maskCtx!.putImageData(this.maskImage!, 0, 0);
    return this.maskCanvas!;
  }

  /**
   * Turns the raw mask into one with a usable edge.
   *
   * The model's mask is binary at 256x144. Stretching that straight to 1080p is
   * a 7.5x blow-up of a hard step, so every edge arrives as a visible
   * staircase — and because the model re-decides each frame independently, the
   * staircase also crawls. Two cheap passes fix both:
   *
   *  - refine at an intermediate width, where the upscale resolves the
   *    staircase into a ramp, then blur it into a real feather. The radius is
   *    small enough that the body stays fully opaque and only the boundary
   *    softens, so this reads as an anti-aliased edge rather than a haze.
   *  - ease against the previous frame's mask. Drawing the new one at partial
   *    alpha over the kept canvas *is* the interpolation, so it costs one draw
   *    and no extra buffer.
   *
   * The edge is also pushed out by a pixel: at the true boundary the feather
   * sits near 50%, which would make fine hair half-transparent.
   */
  private featheredMask(
    raw: OffscreenCanvas | HTMLCanvasElement,
    frameW: number,
    frameH: number
  ) {
    const w = Math.min(MASK_WORK_WIDTH, frameW);
    const h = Math.max(2, Math.round((w * frameH) / frameW));

    if (!this.softCanvas || this.softCanvas.width !== w || this.softCanvas.height !== h) {
      this.softCanvas = createCanvas(w, h);
      this.softCtx = this.softCanvas.getContext(
        "2d"
      ) as CanvasRenderingContext2D;
    }
    const ctx = this.softCtx!;
    const drawRaw = () =>
      ctx.drawImage(
        raw as CanvasImageSource,
        -MASK_DILATE_PX,
        -MASK_DILATE_PX,
        w + MASK_DILATE_PX * 2,
        h + MASK_DILATE_PX * 2
      );

    // 1. The feather: a blurred copy, soft on both sides of the silhouette.
    ctx.globalCompositeOperation = "copy";
    ctx.filter = `blur(${MASK_BLUR_PX}px)`;
    drawRaw();

    // 2. Stamp the hard mask back on top. This is what keeps the person solid:
    //    inside the silhouette the alpha is forced back to fully opaque, and
    //    only the ring *outside* it keeps the soft ramp. Without this the blur
    //    lowers alpha across the body as well, and a person drawn at 70% over
    //    a blurred copy of themselves reads as a blurred face — which is
    //    exactly what happened when this eased between frames instead.
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    drawRaw();

    return this.softCanvas;
  }

  /** Blurred-or-replaced background with the primary person laid over it. */
  private composite(
    frame: VideoFrame,
    maskCanvas: OffscreenCanvas | HTMLCanvasElement,
    w: number,
    h: number
  ) {
    const ctx = this.ctx!;

    // 1. Background.
    if (this.background) {
      ctx.filter = "none";
      ctx.drawImage(this.fittedBackground(w, h) as CanvasImageSource, 0, 0);
    } else {
      // Blur small, then scale up. A Gaussian costs roughly the pixel count
      // times the radius, so blurring 1080p directly is the single most
      // expensive thing in this pipeline and it was dropping frames. Working
      // at a quarter size with a quarter radius is ~16x less work, and the
      // result is indistinguishable: a blur is throwing away exactly the
      // detail that the downscale would have thrown away anyway. The bilinear
      // upscale even smooths it a little further, for free.
      const sw = Math.max(2, Math.round(w / BLUR_DOWNSCALE));
      const sh = Math.max(2, Math.round(h / BLUR_DOWNSCALE));
      if (!this.blurCanvas || this.blurCanvas.width !== sw || this.blurCanvas.height !== sh) {
        this.blurCanvas = createCanvas(sw, sh);
        this.blurCtx = this.blurCanvas.getContext(
          "2d"
        ) as CanvasRenderingContext2D;
      }
      const bctx = this.blurCtx!;
      // Scale the blur with frame size so it looks the same at any resolution.
      const radius = Math.max(
        4,
        Math.round(((this.options.blurRadius ?? 12) * w) / 1280)
      );
      bctx.filter = `blur(${Math.max(1, Math.round(radius / BLUR_DOWNSCALE))}px)`;
      bctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, sw, sh);
      bctx.filter = "none";
      ctx.filter = "none";
      ctx.drawImage(this.blurCanvas as CanvasImageSource, 0, 0, w, h);
    }

    // 2. Cut the person out of the sharp frame using the mask as alpha.
    if (
      !this.personCanvas ||
      this.personCanvas.width !== w ||
      this.personCanvas.height !== h
    ) {
      this.personCanvas = createCanvas(w, h);
      this.personCtx = this.personCanvas.getContext(
        "2d"
      ) as CanvasRenderingContext2D;
    }
    const pctx = this.personCtx!;
    pctx.globalCompositeOperation = "source-over";
    pctx.clearRect(0, 0, w, h);
    pctx.filter = "none";
    pctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
    pctx.globalCompositeOperation = "destination-in";
    // The mask arrives already feathered and eased (featheredMask), so this is
    // a plain stretch — the softness is in the mask, not in this upscale.
    pctx.drawImage(
      this.featheredMask(maskCanvas, w, h) as CanvasImageSource,
      0,
      0,
      w,
      h
    );
    pctx.globalCompositeOperation = "source-over";

    // 3. Person over background.
    ctx.drawImage(this.personCanvas as CanvasImageSource, 0, 0);
  }

  /**
   * Fits the chosen image to the frame, rendered once per image/size.
   *
   * Plain "cover" only works when the picture is roughly the same shape as the
   * video: a phone photo cropped to fill a 16:9 frame loses about two thirds of
   * itself, which is what "the background doesn't fit" looks like. So when the
   * shapes differ, the whole picture is shown centred and the space around it is
   * filled with a blurred, zoomed copy of itself — nothing important is cut off
   * and there are no black bars.
   */
  private fittedBackground(w: number, h: number) {
    const img = this.background!.image;
    const key = `${this.background!.path}|${w}x${h}`;
    if (this.bgCanvas && this.bgKey === key) return this.bgCanvas;

    const canvas = createCanvas(w, h);
    const c = canvas.getContext("2d") as CanvasRenderingContext2D;

    // Always fill the frame, cropping whatever doesn't fit, which is what every
    // video app does with a virtual background.
    //
    // This previously showed a mismatched image whole, centred on a blurred
    // enlargement of itself, to avoid cropping. That was the wrong call: it
    // looks like a photo pasted onto a blurry mat rather than a background you
    // are sitting in front of, and it's most obvious with an uploaded phone
    // photo — exactly the case it was meant to help. There is no way to show a
    // whole portrait photo behind landscape video; filling and cropping to the
    // centre at least looks deliberate.
    drawCover(c, img, w, h);

    this.bgCanvas = canvas;
    this.bgKey = key;
    return canvas;
  }
}

/* ---------------- helpers ---------------- */

function createCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** object-fit: contain — the whole picture, centred, nothing cropped. */

/** object-fit: cover, so a background image never stretches. */
function drawCover(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  img: ImageBitmap,
  w: number,
  h: number
) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
