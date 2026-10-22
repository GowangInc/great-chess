// Original geometric drawings; no historical artwork is reproduced.
const drawings = {
  king: '<path d="M24 4v10m-5-5h10M13 20l5 15h12l5-15-7 4-4-9-4 9z"/><path d="M15 39h18M13 43h22"/>',
  prince: '<path d="M15 13l9 8 9-8-3 21H18z"/><circle cx="24" cy="8" r="3"/><path d="M15 39h18M13 43h22"/>',
  adventitious: '<path d="M24 4l5 9 10 2-7 8 1 11H15l1-11-7-8 10-2z"/><circle cx="24" cy="23" r="4"/><path d="M15 39h18M13 43h22"/>',
  rook: '<path d="M12 8v12h5l-2 18h18l-2-18h5V8h-6v7h-4V8h-5v7h-4V8z"/><path d="M12 43h24M17 27h14"/>',
  knight: '<path d="M14 38l3-12 13-7-9-2-8 6-4-6 10-9 1-5 7 6 6 2 4 14-5 13z"/><circle cx="25" cy="14" r="1.3" fill="currentColor"/><path d="M12 43h24"/>',
  picket: '<path d="M24 4l9 14-6 10 6 10H15l6-10-6-10z"/><path d="M19 18h10M24 9v14M12 43h24"/>',
  giraffe: '<path d="M15 39l5-19-4-4 5-7 12 1 4 6-10 1 1 22z"/><path d="M22 9V4m7 6V5M21 26l6 3m-8 3 8 3M12 43h24"/><circle cx="29" cy="13" r="1" fill="currentColor"/>',
  ferz: '<path d="M24 6l13 16-13 16-13-16z"/><path d="M24 14l6 8-6 8-6-8zM12 43h24"/>',
  vizier: '<path d="M18 9h12v10h9v10h-9v10H18V29H9V19h9z"/><path d="M12 43h24"/>',
  elephant: '<path d="M12 38V21Q12 8 25 8q13 0 13 13v15q-6 3-8-3V21h-5v17z"/><path d="M20 13q-8 11 3 15M33 28l-4 6M11 43h27"/><circle cx="31" cy="16" r="1.3" fill="currentColor"/>',
  camel: '<path d="M9 38V27q1-10 8-7 4-15 9 0l5 3 1-13 7 2-4 10-1 16z"/><path d="M12 43h25M34 10V6"/><circle cx="36" cy="14" r="1" fill="currentColor"/>',
  engine: '<path d="M9 32l6-17h18l6 17zM15 15V9h18v6M13 27h22M24 16v15"/><circle cx="16" cy="36" r="5"/><circle cx="32" cy="36" r="5"/><path d="M10 44h28"/>',
  pawn: '<circle cx="24" cy="12" r="7"/><path d="M21 20l-5 16h16l-5-16zM13 41h22"/>'
};
const badges = {pawn:'P',engine:'E',camel:'C',elephant:'El',ferz:'F',prince:'K',vizier:'V',giraffe:'G',picket:'Pi',knight:'N',rook:'R'};
export function pieceSVG(piece, {badge = true} = {}) {
  const type = Object.hasOwn(drawings, piece.type) ? piece.type : 'pawn';
  const color = piece.color === 'black' ? 'black' : 'white';
  const mark = type === 'pawn' && badge ? `<g class="promotion-badge"><rect x="29" y="29" width="18" height="16" rx="3"/><text x="38" y="40">${badges[piece.promotion] || 'P'}${piece.stage ? `<tspan dy="-3" font-size="6">${Math.min(2, Number(piece.stage) || 0)}</tspan>` : ''}</text></g>` : '';
  return `<svg class="piece-art piece-${color}${piece.dormant ? ' piece-dormant' : ''}" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><g class="piece-shape" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${drawings[type]}</g>${mark}</svg>`;
}
