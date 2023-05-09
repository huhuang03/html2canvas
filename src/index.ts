import {Bounds, parseBounds, parseDocumentSize} from './css/layout/bounds';
import {COLORS, isTransparent, parseColor} from './css/types/color';
import {CloneConfigurations, CloneOptions, DocumentCloner, WindowOptions} from './dom/document-cloner';
import {isBodyElement, isHTMLElement, parseTree} from './dom/node-parser';
import {CacheStorage} from './core/cache-storage';
import {CanvasRenderer, RenderConfigurations, RenderOptions} from './render/canvas/canvas-renderer';
import {ForeignObjectRenderer} from './render/canvas/foreignobject-renderer';
import {Context, ContextOptions} from './core/context';

export type Options = CloneOptions &
    WindowOptions &
    RenderOptions &
    ContextOptions & {
        backgroundColor: string | null;
        foreignObjectRendering: boolean;
        removeContainer?: boolean;
    };

export async function html2canvasSegmentedGetBlobList(
    ele: HTMLElement,
    option: Partial<Options> = {},
    segmentHeight: number,
    mineType = 'image/jpeg'
): Promise<Blob[]> {
    const rst: Blob[] = [];
    await html2canvasSegmented(ele, option, segmentHeight, (c) => {
        return new Promise<Blob>((resolve, reject) => {
            c.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('to blob failed!'));
                    }
                },
                mineType,
                1
            );
        }).then((blob) => rst.push(blob));
    });
    return rst;
}

/**
 * 分段截屏，如果成功返回Promise.resolve(true)。如果失败，会reject
 * @param ele
 * @param option
 * @param segmentHeight
 * @param op 对canvas的操作，如果是一个异步操作，需要返回一个Promise
 */
export async function html2canvasSegmented(
    ele: HTMLElement,
    option: Partial<Options> = {},
    segmentHeight: number,
    op: (canvas: HTMLCanvasElement) => Promise<unknown> | undefined | null
): Promise<void> {
    if (ele == null) {
        return Promise.reject(Error('element is null'));
    }

    const {context, container, clonedElement} = await prepare(ele, option);

    const scale = window.devicePixelRatio;
    let canvas: HTMLCanvasElement | null = document.createElement('canvas');
    const tmpCtx = canvas.getContext('2d');
    if (!tmpCtx) {
        throw new Error('ctx is null, maybe used too may resources');
    }
    const width = ele.scrollWidth;

    canvas.width = Math.floor(scale * width);
    canvas.height = Math.floor(scale * segmentHeight);

    const totalHeight = ele.scrollHeight;
    let curTop = 0;
    while (curTop < totalHeight) {
        const height = Math.min(totalHeight - curTop, segmentHeight);
        canvas.width = Math.floor(scale * width);
        canvas.height = Math.floor(scale * height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('ctx is null, maybe used too may resources');
        }
        ctx.getContextAttributes().willReadFrequently = true;

        const c = await render(context, ele, clonedElement, {
            ...option,
            canvas,
            y: curTop,
            height: height,
            width: ele.scrollWidth
        });
        const rst = op(c);
        if (rst && typeof rst.then === 'function') {
            await rst;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        releaseCanvas(c);
        curTop += height;
    }
    canvas.remove();
    canvas = null;
    destroyContainer(container);
}

export const html2canvas = (element: HTMLElement, options: Partial<Options> = {}): Promise<HTMLCanvasElement> => {
    return renderElement(element, options);
};

// export default html2canvas;

if (typeof window !== 'undefined') {
    CacheStorage.setContext(window);
}

export const destroyContainer = (container: HTMLIFrameElement): boolean => {
    return DocumentCloner.destroy(container);
};

const renderElement = async (element: HTMLElement, opts: Partial<Options>): Promise<HTMLCanvasElement> => {
    const {context, clonedElement, container} = await prepare(element, opts);
    const canvas = await render(context, element, clonedElement, opts);
    if (opts.removeContainer ?? true) {
        if (!destroyContainer(container)) {
            context.logger.error(`Cannot detach cloned iframe as it is not in the DOM anymore`);
        }
    }
    context.logger.debug(`Finished rendering`);
    return canvas;
};

export const prepare = async (
    element: HTMLElement,
    opts: Partial<Options>
): Promise<{context: Context; clonedElement: HTMLElement; container: HTMLIFrameElement}> => {
    if (!element || typeof element !== 'object') {
        return Promise.reject('Invalid element provided as first argument');
    }
    const ownerDocument = element.ownerDocument;

    if (!ownerDocument) {
        throw new Error(`Element is not attached to a Document`);
    }

    const defaultView = ownerDocument.defaultView;

    if (!defaultView) {
        throw new Error(`Document is not attached to a Window`);
    }

    const resourceOptions = {
        allowTaint: opts.allowTaint ?? false,
        imageTimeout: opts.imageTimeout ?? 15000,
        proxy: opts.proxy,
        useCORS: opts.useCORS ?? false
    };

    const contextOptions = {
        logging: opts.logging ?? true,
        cache: opts.cache,
        ...resourceOptions
    };

    const windowOptions = {
        windowWidth: opts.windowWidth ?? defaultView.innerWidth,
        windowHeight: opts.windowHeight ?? defaultView.innerHeight,
        scrollX: opts.scrollX ?? defaultView.pageXOffset,
        scrollY: opts.scrollY ?? defaultView.pageYOffset
    };

    const windowBounds = new Bounds(
        windowOptions.scrollX,
        windowOptions.scrollY,
        windowOptions.windowWidth,
        windowOptions.windowHeight
    );

    const context = new Context(contextOptions, windowBounds);

    const foreignObjectRendering = opts.foreignObjectRendering ?? false;

    const cloneOptions: CloneConfigurations = {
        allowTaint: opts.allowTaint ?? false,
        onclone: opts.onclone,
        ignoreElements: opts.ignoreElements,
        inlineImages: foreignObjectRendering,
        copyStyles: foreignObjectRendering
    };

    context.logger.debug(
        `Starting document clone with size ${windowBounds.width}x${
            windowBounds.height
        } scrolled to ${-windowBounds.left},${-windowBounds.top}`
    );

    const documentCloner = new DocumentCloner(context, element, cloneOptions);
    const clonedElement = documentCloner.clonedReferenceElement;
    if (!clonedElement) {
        return Promise.reject(`Unable to find element in cloned iframe`);
    }
    const container = await documentCloner.toIFrame(ownerDocument, windowBounds);
    return Promise.resolve({context: context, clonedElement: clonedElement, container});
};

export const render = async (
    context: Context,
    element: HTMLElement,
    clonedElement: HTMLElement,
    opts: Partial<Options>
): Promise<HTMLCanvasElement> => {
    const ownerDocument = element.ownerDocument;
    const defaultView = ownerDocument.defaultView;
    if (!defaultView) {
        throw new Error(`Document is not attached to a Window`);
    }

    const foreignObjectRendering = opts.foreignObjectRendering ?? false;

    const {width, height, left, top} =
        isBodyElement(clonedElement) || isHTMLElement(clonedElement)
            ? parseDocumentSize(clonedElement.ownerDocument)
            : parseBounds(context, clonedElement);

    const backgroundColor = parseBackgroundColor(context, clonedElement, opts.backgroundColor);

    const renderOptions: RenderConfigurations = {
        canvas: opts.canvas,
        backgroundColor,
        scale: opts.scale ?? defaultView.devicePixelRatio ?? 1,
        x: (opts.x ?? 0) + left,
        y: (opts.y ?? 0) + top,
        width: opts.width ?? Math.ceil(width),
        height: opts.height ?? Math.ceil(height)
    };
    const beginTime = new Date().getTime();

    let canvas;

    if (foreignObjectRendering) {
        context.logger.debug(`Document cloned, using foreign object rendering`);
        const renderer = new ForeignObjectRenderer(context, renderOptions);
        canvas = await renderer.render(clonedElement);
    } else {
        context.logger.debug(
            `Document cloned, element located at ${left},${top} with size ${width}x${height} using computed rendering`
        );

        context.logger.debug(`Starting DOM parsing`);
        const root = parseTree(context, clonedElement);

        if (backgroundColor === root.styles.backgroundColor) {
            root.styles.backgroundColor = COLORS.TRANSPARENT;
        }

        context.logger.debug(
            `Starting renderer for element at ${renderOptions.x},${renderOptions.y} with size ${renderOptions.width}x${renderOptions.height}`
        );

        const renderer = new CanvasRenderer(context, renderOptions);
        canvas = await renderer.render(root);
    }
    return canvas;
};

const parseBackgroundColor = (context: Context, element: HTMLElement, backgroundColorOverride?: string | null) => {
    const ownerDocument = element.ownerDocument;
    // http://www.w3.org/TR/css3-background/#special-backgrounds
    const documentBackgroundColor = ownerDocument.documentElement
        ? parseColor(context, getComputedStyle(ownerDocument.documentElement).backgroundColor as string)
        : COLORS.TRANSPARENT;
    const bodyBackgroundColor = ownerDocument.body
        ? parseColor(context, getComputedStyle(ownerDocument.body).backgroundColor as string)
        : COLORS.TRANSPARENT;

    const defaultBackgroundColor =
        typeof backgroundColorOverride === 'string'
            ? parseColor(context, backgroundColorOverride)
            : backgroundColorOverride === null
            ? COLORS.TRANSPARENT
            : 0xffffffff;

    return element === ownerDocument.documentElement
        ? isTransparent(documentBackgroundColor)
            ? isTransparent(bodyBackgroundColor)
                ? defaultBackgroundColor
                : bodyBackgroundColor
            : documentBackgroundColor
        : defaultBackgroundColor;
};

function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx && ctx.clearRect(0, 0, 1, 1);
}
