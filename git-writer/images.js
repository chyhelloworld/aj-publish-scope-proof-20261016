const LIMIT = 2 * 1024 * 1024;
export async function prepareImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw Error('请选择 PNG、JPEG 或 WebP 图片。');
  if (file.size <= LIMIT) return { file, changed: false };
  if (file.type === 'image/webp')
    throw Error('这张 WebP 超过 2 MiB，请先缩小；不会自动把动画转成静态图片。');
  if (file.size > 25 * 1024 * 1024)
    throw Error('这张图片超过 25 MiB，请先缩小后选择。');
  if (typeof createImageBitmap !== 'function')
    throw Error('当前浏览器不能处理大图，请先缩小图片或使用新版浏览器。');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw Error('图片无法解码，请换一个有效图片文件。');
  }
  try {
    if (bitmap.width * bitmap.height > 40_000_000)
      throw Error('图片分辨率过大，请先缩小后选择。');
    for (const maximum of [2048, 1440, 1024]) {
      const scale = Math.min(
        1,
        maximum / Math.max(bitmap.width, bitmap.height),
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext('2d');
      if (!context) throw Error('当前浏览器不能处理大图，请先缩小图片。');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/webp', 0.82),
      );
      if (blob && blob.type === 'image/webp' && blob.size <= LIMIT)
        return {
          file: new File([blob], file.name.replace(/\.[^.]*$/, '') + '.webp', {
            type: 'image/webp',
          }),
          changed: true,
          originalBytes: file.size,
          width: canvas.width,
          height: canvas.height,
        };
    }
    throw Error('图片缩小后仍超过 2 MiB，请换一张较小图片。');
  } finally {
    bitmap.close();
  }
}
export function observePreviewImages(container, { checkSession, onExpired }) {
  for (const image of container.querySelectorAll('img')) {
    const feedback = document.createElement('div');
    feedback.className = 'image-feedback';
    feedback.setAttribute('aria-live', 'polite');
    image.after(feedback);
    const loading = () => {
      feedback.textContent = '图片加载中…';
    };
    image.addEventListener('load', () => {
      feedback.textContent = '';
    });
    image.addEventListener('error', async () => {
      feedback.replaceChildren(
        document.createTextNode('图片暂时无法读取，正文与引用已保留。 '),
      );
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试图片';
      retry.className = 'quiet';
      feedback.append(retry);
      retry.onclick = () => {
        loading();
        const src = new URL(image.src, location.href);
        src.searchParams.set('retry', Date.now().toString());
        image.src = src.href;
      };
      try {
        await checkSession();
      } catch (error) {
        if (error.status === 401) {
          onExpired();
          feedback.prepend(document.createTextNode('登录已过期。 '));
        }
      }
    });
    if (image.complete && image.naturalWidth > 0) feedback.textContent = '';
    else if (image.complete) image.dispatchEvent(new Event('error'));
    else loading();
  }
}
