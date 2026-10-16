/** 제자리 문자 편집기 스타일(접두사 te-). 테마 변수(src/styles.css)를 쓴다. 도면 영역은 어느 테마에서나 어둡다 */
const CSS = `
.te-wrap{position:fixed;left:0;top:0;z-index:55;transform-origin:0 0;pointer-events:auto}
.te-box{min-width:2.2em;min-height:1.2em;padding:2px 4px;outline:1px dashed var(--accent);background:rgba(16,20,26,.93);color:#e8ebf0;
  white-space:pre-wrap;overflow-wrap:break-word;word-break:keep-all;tab-size:4;caret-color:var(--accent);cursor:text;box-sizing:content-box}
.te-box:focus{outline:1px solid var(--accent)}
.te-box.te-nowrap{white-space:pre}
.te-box .te-p{margin:0;min-height:1em}
.te-box .te-p.te-col{border-top:1px dashed rgba(61,149,240,.6);break-before:column}
.te-box .te-a{display:inline-block;user-select:all;cursor:default;border-radius:2px}
.te-box .te-field,.te-box .te-measure{background:rgba(150,150,150,.35);padding:0 1px}
.te-box .te-stack{vertical-align:middle;text-align:center;line-height:1;font-size:.72em;margin:0 1px}
.te-box .te-stack>span{display:block}
.te-box .te-st-frac .te-st-top{border-bottom:1px solid currentColor}
.te-box .te-st-diag{display:inline-flex;align-items:center;gap:1px}
.te-box .te-st-diag>span{display:inline}
.te-box .te-st-diag .te-st-top{position:relative;top:-.35em}
.te-box .te-st-diag .te-st-bot{position:relative;top:.35em}
.te-box .te-a.te-hot{outline:1px solid var(--accent)}
.te-handle{position:absolute;right:-5px;top:50%;width:8px;height:14px;margin-top:-7px;background:var(--accent);border-radius:2px;cursor:ew-resize}
.te-bar{position:fixed;z-index:56;display:flex;flex-wrap:wrap;gap:3px;align-items:center;max-width:min(980px,calc(100vw - 16px));
  padding:4px 6px;background:var(--bg-panel);border:1px solid var(--border-soft);border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,.35);font:12px var(--font);color:var(--text)}
.te-bar .te-grp{display:flex;gap:2px;align-items:center;padding-right:4px;margin-right:2px;border-right:1px solid var(--border-soft)}
.te-bar .te-grp:last-child{border-right:0}
.te-bar button{min-width:24px;height:24px;padding:0 5px;border:1px solid transparent;border-radius:3px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.te-bar button:hover{background:var(--bg-hover)}
.te-bar button[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent)}
.te-bar button.te-ok{background:var(--bg-active);color:#fff}
.te-bar button:disabled{opacity:.45;cursor:default}
.te-bar select,.te-bar input{height:24px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;font:inherit;padding:0 3px}
.te-bar input{width:56px}
.te-bar .te-lbl{color:var(--text-dim);margin:0 2px}
.te-bar .te-more{display:none;width:100%;gap:6px;align-items:center;padding-top:3px;border-top:1px solid var(--border-soft)}
.te-bar.te-show-more .te-more{display:flex;flex-wrap:wrap}
`;

let installed = false;

export function installEditorStyle(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const el = document.createElement('style');
  el.id = 'te-style';
  el.textContent = CSS;
  document.head.append(el);
}
