const base = '/api/author/git-content-proof';
const status = document.querySelector('#status'),
  result = document.querySelector('#result'),
  run = document.querySelector('#run'),
  read = document.querySelector('#read'),
  input = document.querySelector('#run-id'),
  picture = document.querySelector('#picture');
input.value = sessionStorage.getItem('privateGitProofRunId') || '';
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: body
      ? { 'Content-Type': 'application/json', 'X-Author-Probe': '1' }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? '登录已过期，请重新登录后回到本页。'
        : data.error || `请求失败（${response.status}）`,
    );
  return data;
}
function show(data) {
  result.textContent = JSON.stringify(data, null, 2);
  if (data.phase === 'restored') {
    picture.replaceChildren();
    const image = document.createElement('img');
    image.alt = '恢复后的私有合成图片';
    image.src = base + '/image/' + data.id;
    image.onerror = () => {
      status.textContent =
        '正文恢复结果已取得，图片未读回；可重新登录后只读检查。';
    };
    picture.append(image);
  }
}
async function check() {
  try {
    const data = await request('/status');
    status.textContent = data.configured
      ? '配置已就绪，可进行合成验证。'
      : '已登录，App 测试凭据尚未配置完整。';
    run.disabled = !data.configured;
  } catch (error) {
    status.textContent = error.message;
  }
}
run.addEventListener('click', async () => {
  run.disabled = true;
  read.disabled = true;
  picture.replaceChildren();
  input.value = crypto.randomUUID();
  sessionStorage.setItem('privateGitProofRunId', input.value);
  try {
    for (const [step, label] of [
      ['create', '创建并读回合成稿'],
      ['race', '验证真实并发与草稿隔离'],
      ['backup', '备份正文与私有图片'],
      ['restore', '恢复到独立测试位置'],
    ]) {
      status.textContent = label + '…';
      show(await request('/' + step, { runId: input.value }));
    }
    status.textContent = '合成验证完成，请核对结果及恢复图片。';
  } catch (error) {
    status.textContent =
      error.message + ' 此轮已停止，没有自动重试；可只读检查结果。';
  } finally {
    read.disabled = false;
    run.disabled = false;
  }
});
read.addEventListener('click', async () => {
  if (!input.value) {
    status.textContent = '当前页面还没有验证 ID。';
    return;
  }
  try {
    show(await request('/result/' + input.value));
    status.textContent = '已读取服务器记录，未触发写入。';
  } catch (error) {
    status.textContent = error.message;
  }
});
check();
