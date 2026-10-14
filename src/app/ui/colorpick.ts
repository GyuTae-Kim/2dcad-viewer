/** 색 고르기: 색인 색(ACI 1~255), ByLayer·ByBlock, 트루컬러 */
import type { CadColor } from '../../core/model';
import { aciToRgb, nearestAci, rgbToCss } from '../../core/color';
import { colorText } from '../inquiry';
import { dialog, h } from './dom';

export function pickColor(current: CadColor, opt: { allowBy?: boolean; dark?: boolean } = {}): Promise<CadColor | null> {
  const dark = opt.dark ?? true;
  return new Promise((resolve) => {
    let chosen: CadColor = { ...current };
    let done = false;
    const preview = h('span', { class: 'swatch', style: 'width:36px;height:22px' });
    const label = h('b', {});
    const input = h('input', { type: 'color', 'aria-label': '트루컬러' }) as HTMLInputElement;
    const aciIn = h('input', { type: 'text', style: 'width:64px', 'aria-label': '색인 번호' }) as HTMLInputElement;
    const show = () => {
      const rgb = chosen.rgb !== undefined && chosen.aci !== 0 && chosen.aci !== 256 ? chosen.rgb : chosen.aci > 0 && chosen.aci < 256 ? aciToRgb(chosen.aci, dark) : null;
      preview.style.background = rgb === null ? 'transparent' : rgbToCss(rgb);
      preview.style.outline = rgb === null ? '1px dashed var(--border)' : '';
      label.textContent = colorText(chosen);
      if (rgb !== null) input.value = rgbToCss(rgb);
      aciIn.value = chosen.rgb === undefined && chosen.aci > 0 && chosen.aci < 256 ? String(chosen.aci) : '';
      for (const c of grid.querySelectorAll<HTMLButtonElement>('button')) c.classList.toggle('on', chosen.rgb === undefined && Number(c.dataset.aci) === chosen.aci);
    };
    const set = (c: CadColor) => {
      chosen = c;
      show();
    };
    const cell = (aci: number, size = 14) => {
      const b = h('button', {
        class: 'aci',
        title: `색상 ${aci}`,
        'aria-label': `색상 ${aci}`,
        'data-aci': String(aci),
        style: `width:${size}px;height:${size}px;background:${rgbToCss(aciToRgb(aci, dark))}`,
      });
      b.addEventListener('click', () => set({ aci }));
      b.addEventListener('dblclick', () => finish());
      return b;
    };
    const grid = h('div', { class: 'aci-grid' });
    // 10~249: 열 = 색상(10씩), 행 = 밝기·채도(짝수 끝자리 위, 홀수 끝자리 아래)
    const big = h('div', { class: 'aci-big' });
    for (const off of [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]) {
      for (let col = 0; col < 24; col++) big.append(cell(10 + col * 10 + off, 13));
    }
    const basics = h('div', { class: 'aci-row' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((a) => cell(a, 20)));
    const greys = h('div', { class: 'aci-row' }, ...[250, 251, 252, 253, 254, 255].map((a) => cell(a, 20)));
    grid.append(big, basics, greys);
    input.addEventListener('input', () => {
      const v = parseInt(input.value.slice(1), 16);
      if (Number.isFinite(v)) set({ aci: nearestAci(v), rgb: v });
    });
    aciIn.addEventListener('change', () => {
      const n = Number(aciIn.value);
      if (Number.isInteger(n) && n >= 1 && n <= 255) set({ aci: n });
      else show();
    });
    const byRow = opt.allowBy
      ? h(
          'div',
          { style: 'display:flex;gap:6px' },
          h('button', { class: 'btn', onclick: () => set({ aci: 256 }) }, 'ByLayer'),
          h('button', { class: 'btn', onclick: () => set({ aci: 0 }) }, 'ByBlock'),
        )
      : null;
    const body = h(
      'div',
      { class: 'colorpick' },
      grid,
      h('div', { class: 'form-row' }, h('span', {}, '색인 번호'), aciIn),
      h('div', { class: 'form-row' }, h('span', {}, '트루컬러'), input),
      byRow,
      h('div', { class: 'form-row' }, h('span', {}, '고른 색'), h('span', { style: 'display:flex;gap:8px;align-items:center' }, preview, label)),
    );
    const finish = () => {
      if (done) return;
      done = true;
      back.remove();
      resolve(chosen);
    };
    const back = dialog('색 선택', body, [
      { label: '확인', primary: true, run: () => (finish(), true) },
      { label: '취소', run: () => undefined },
    ]);
    const observer = new MutationObserver(() => {
      if (!back.isConnected) {
        observer.disconnect();
        if (!done) {
          done = true;
          resolve(null);
        }
      }
    });
    observer.observe(document.body, { childList: true });
    show();
  });
}
