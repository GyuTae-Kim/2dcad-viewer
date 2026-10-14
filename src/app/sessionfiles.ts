/**
 * 이 세션에서 사용자가 고른 파일(파일 고르기 상자·끌어 놓기)을 이름으로 기억한다.
 * 외부 참조·이미지·PDF·SHX·CTB/STB 파일을 고르는 곳이 여러 군데라, 문서 전체에서 파일 입력의 change와 drop을
 * 포착 단계에서 지켜본다(파일을 읽지도 보내지도 않고 File 참조만 둔다). 전송(ETRANSMIT)이 원래 바이트를 넣을 때 쓴다.
 * 참조 편집으로 고쳐 내려받은 외부 참조는 고친 내용으로 바꿔 둔다.
 */

const files = new Map<string, Blob>();
let installed = false;

const keyOf = (name: string) => name.replace(/^.*[\\/]/, '').toLowerCase();

function remember(list: FileList | null | undefined): void {
  for (const f of [...(list ?? [])]) if (f.name) files.set(keyOf(f.name), f);
}

/** 문서 전체의 파일 고르기·끌어 놓기를 지켜본다(한 번만) */
export function installFileRegistry(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'change',
    (ev) => {
      const t = ev.target;
      if (t instanceof HTMLInputElement && t.type === 'file') remember(t.files);
    },
    true,
  );
  window.addEventListener('drop', (ev) => remember(ev.dataTransfer?.files), true);
}

/** 파일을 기억한다(같은 이름이면 바꾼다) */
export function rememberFile(name: string, data: Blob): void {
  files.set(keyOf(name), data);
}

/** 이 세션에서 고른 그 이름의 파일(경로는 무시, 대소문자 무시) */
export function sessionFile(name: string): Blob | null {
  return files.get(keyOf(name)) ?? null;
}

export function sessionFileNames(): string[] {
  return [...files.keys()];
}
