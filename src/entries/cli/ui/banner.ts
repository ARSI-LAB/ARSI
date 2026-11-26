import boxen from 'boxen';
import colors from 'picocolors';
import stringWidth from 'string-width';

// Resampled from the flame mark in docs/users/assets/arsi-logo.png.
const logo = [
  '........oo........',
  '........ooo.......',
  '.........ooo......',
  '.........oooo.....',
  '.........ooooo....',
  '........oooooo....',
  '....oo..ooooooo...',
  '...ooo.oooooooo...',
  '..oooooooooooooo..',
  '.oooooooooooooooo.',
  '.oooooooooooooooo.',
  'oooo###oooo##ooooo',
  'ooo#ooo#oo#oo##ooo',
  'oooooooooooooooooo',
  'oooooooooooooooooo',
  'oooo##ooooooooooo.',
  '.oooo#oooooo#oooo.',
  '.ooooo#ooo##oooo..',
  '..ooooooooooooo...',
  '...ooooooooooo....',
  '....ooooooooo.....',
  '......ooooo.......',
];

function logoCell(top: string, bottom: string): string {
  if (top === '.' && bottom === '.') return ' ';
  const foreground = (top === '.' ? bottom : top) === 'o' ? 202 : 16;
  const background = bottom === 'o' ? 202 : 16;
  const glyph = top === bottom ? '█' : top === '.' ? '▄' : '▀';
  const fill =
    top !== '.' && bottom !== '.' && top !== bottom
      ? ';48;5;' + background
      : '';
  return '\x1b[38;5;' + foreground + fill + 'm' + glyph + '\x1b[39;49m';
}

export function renderBanner({
  version,
  workspace,
  level,
  columns = 80,
  color = false,
}: {
  version: string;
  workspace: string;
  level: string;
  columns?: number;
  color?: boolean;
}): string {
  const text = [
    colors.bold(`ARSI ${version} · Node ${process.version}`),
    `Workspace ${workspace}`,
    `Log level ${level}`,
  ];
  const logoWidth = logo[0]!.length;
  const gap = '   ';
  const frameWidth = 4;
  const logoRows = logo.length / 2;
  const firstLabel = Math.floor((logoRows - text.length) / 2);
  const showLogo =
    color &&
    logoWidth +
      gap.length +
      frameWidth +
      Math.max(...text.map((line) => stringWidth(line))) <=
      columns;
  const lines = showLogo
    ? Array.from({ length: logoRows }, (_, row) => {
        const top = logo[row * 2]!;
        const bottom = logo[row * 2 + 1]!;
        const mark = Array.from(top, (pixel, col) =>
          logoCell(pixel, bottom[col]!),
        ).join('');
        const label = text[row - firstLabel];
        return label ? mark + gap + label : mark;
      })
    : text;
  return boxen(lines.join('\n'), {
    borderStyle: 'round',
    borderColor: 'cyan',
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
  });
}
