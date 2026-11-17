// 验证用：先把地形关掉，再点图层面板里的“地形”复选框，记录点击前后的状态。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = () => {
    for (const input of document.querySelectorAll('input[type=checkbox]')) {
      const row = input.closest('label, li, div');
      if (row && row.textContent.trim() === '地形') return input;
    }
    return null;
  };
  const snap = () => {
    const box = find();
    return { enabled: GE.terrain.enabled, checkbox: box ? box.checked : null };
  };

  await GE.terrain.setEnabled(false);
  await sleep(300);
  const before = snap();

  const box = find();
  if (!box) return { error: '没找到“地形”复选框', before };
  box.click();
  await sleep(4000);
  const afterOn = snap();

  find().click();
  await sleep(1500);
  const afterOff = snap();

  find().click();
  await sleep(3000);
  return { before, afterOn, afterOff, finalOn: snap(), statusbar: document.querySelector('#statusbar') ? document.querySelector('#statusbar').textContent.replace(/\s+/g, ' ').trim() : null };
})()
