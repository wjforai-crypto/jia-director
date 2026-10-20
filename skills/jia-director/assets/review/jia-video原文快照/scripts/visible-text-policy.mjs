/** Policy for authored text rendered inside video frames, not metadata or paths. */
const PRODUCTION_LABELS = [
  { name: 'AI情境示意', pattern: /AI情境示意/iu },
  { name: 'AI示意', pattern: /AI示意/iu },
  { name: '初稿', pattern: /初稿/u },
  { name: '样片', pattern: /样片/u },
  { name: '未定稿', pattern: /未定稿/u },
  { name: '试片', pattern: /试片/u },
  { name: '工程小样', pattern: /工程小样/u },
  { name: '工程验证', pattern: /工程验证/u },
  { name: '工程演示文案', pattern: /工程演示文案/u },
];

/**
 * Validate one already parsed on-screen string and return it unchanged.
 * The label must identify the input field (for example shots[0].params.title).
 * NFKC and ignorable separators are used only for detection, so typography and
 * legitimate AI/technical subject matter are preserved in the returned value.
 */
export function assertVisibleText(value, label = 'visible text') {
  if (typeof value !== 'string') throw new Error(`${label}: on-screen text must be a string`);
  const comparable = value.normalize('NFKC').replace(/[\p{White_Space}\p{Cf}·•・|｜/\\_—–-]/gu, '');
  const forbidden = PRODUCTION_LABELS.find(({ pattern }) => pattern.test(comparable));
  if (forbidden) {
    throw new Error(`${label}: on-screen production label "${forbidden.name}" is not allowed; keep production status in delivery documents`);
  }
  return value;
}
