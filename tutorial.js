import {emptyState, applyMove} from './engine.js?v=3';

function position(pieces, extra = {}) {
  const state = emptyState();
  state.board = {'0,0': {id:'wk',type:'king',color:'white'},'10,9': {id:'bk',type:'king',color:'black'}};
  for (const [key,type,color = 'white',metadata = {}] of pieces) state.board[key] = {id:`lesson-${key}`,type,color,...metadata};
  return Object.assign(state, {turn:'white'}, extra);
}
const exercise = (id,title,text,task,pieces,from,to,explanation,extra) => ({id,title,text,task,explanation,createState:()=>position(pieces,extra),accepts:move=>move.from===from && move.to===to});
export const LESSONS = [
  exercise('rook','01 / Lines of command','A rook travels any distance along a rank or file. Other pieces block its path.','Move the rook from d4 to d8.',[['3,3','rook']],'3,3','3,7','The rook is the familiar straight-line slider. A move ends on the first enemy it captures.'),
  exercise('knight','02 / The knight leaps','The knight leaps two squares in one direction and one across. Intervening pieces do not block it.','Jump the knight from d4 to f5.',[['3,3','knight'],['4,3','pawn','white',{promotion:'rook'}]],'3,3','5,4','Leapers ignore intermediate squares, but cannot land on a friendly piece.'),
  exercise('ferz','03 / The diagonal counsellor','The general, also called the ferz, moves exactly one square diagonally. It is not a modern chess queen.','Move the ferz from f5 to g6.',[['5,4','ferz']],'5,4','6,5','The ferz stays on the same square colour throughout the game.'),
  exercise('vizier','04 / The straight counsellor','The vizier moves exactly one square orthogonally: forward, back, left or right.','Move the vizier from f5 to f6.',[['5,4','vizier']],'5,4','5,5','Ferz and vizier divide the diagonal and orthogonal powers of a king.'),
  exercise('elephant','05 / The elephant leaps','The elephant leaps exactly two squares diagonally, over anything in between.','Leap the elephant from d4 to f6.',[['3,3','elephant'],['4,4','pawn','white',{promotion:'ferz'}]],'3,3','5,5','This elephant is a (2,2) leaper, not a bishop. Its geometric icon has a curled ear and trunk.'),
  exercise('camel','06 / The long knight','The camel leaps three squares along one axis and one along the other.','Leap the camel from d4 to e7.',[['3,3','camel']],'3,3','4,6','The camel’s (3,1) leap is longer than a knight’s (2,1).'),
  exercise('engine','07 / The siege engine','The war engine leaps exactly two squares along a rank or file.','Leap the engine from f5 to f7.',[['5,4','engine'],['5,5','pawn','white',{promotion:'engine'}]],'5,4','5,6','An engine jumps the intermediate square. It cannot slide farther.'),
  exercise('picket','08 / Keep your distance','The picket slides diagonally, but must travel at least two squares. Even its unlandable first square must be clear.','Move the picket from d4 to g7.',[['3,3','picket']],'3,3','6,6','Unlike an elephant, the picket is a slider. Every square along the diagonal must be clear.'),
  exercise('giraffe','09 / A bent journey','The giraffe steps one diagonal, then at least three orthogonal steps outward. The whole bent path must be clear.','Move the giraffe from d4 to e8: one diagonal, then three forward.',[['3,3','giraffe']],'3,3','4,7','The shortest giraffe move is (1,4) or (4,1). It may extend the straight part, but cannot turn back.'),
  exercise('pawn','10 / Every pawn has a destiny','Pawns advance one square, never two. They capture one diagonal forward. The small badge names the piece they become on the far rank, determined by their original file—not their current file.','Advance the elephant-pawn from d9 to d10 to promote.',[['3,8','pawn','white',{promotion:'elephant'}]],'3,8','3,9','El means elephant; the original d-file pawn becomes an elephant even if it changes files through captures. The king-pawn becomes a prince. There is no en passant or castling in this reconstruction.'),
  exercise('royal','11 / Guard the last royal','Kings, princes and adventitious kings step one square in any direction. Your last royal must escape attack. Stalemate, like checkmate, loses.','Move your checked king from a1 to b1.',[['0,5','rook','black']],'0,0','1,0','With more than one royal, a royal can be captured normally. Only the final royal is protected by check rules. Bare royal alone is not a loss.'),
  {...exercise('exchange','12 / A once-only escape','Only when checked, your reigning king may once exchange with any friendly piece, including another royal. Citadel restrictions and last-royal safety still apply.','Select a1, then choose “Royal exchange” with the prince on e3.',[['0,5','rook','black'],['4,2','prince']],'0,0','4,2','Exchange uses the turn and is not castling. Here the rook attacks the king on a1, and the friendly prince is an eligible partner. Stalemate does not grant an exchange.'), accepts:move=>move.kind==='exchange' && move.from==='0,0' && move.to==='4,2'},
  {...exercise('citadel','13 / Beyond the board','Only your reigning royal may enter the opponent’s citadel. White’s destination is the extra square left of a9. Entry immediately draws the game.','Enter the black citadel with the king on a9.',[['0,0','rook'],['0,8','king']],'0,8','-1,8','Entry itself ends the game as a draw. Only an adventitious king may shelter in its own citadel; that is a different rule.'), accepts:(move,before,after)=>move.from==='0,8' && move.to==='-1,8' && after.result?.reason==='citadel draw'},
  exercise('pawn-pawn','14 / A pawn unlike the others','The pawn-of-pawns first reaches the far rank and becomes a dormant, immune pawn. It may later redeploy to fork two enemies or attack a unit with no legal escape.','Advance the pawn-of-pawns from d9 to d10.',[['3,8','pawn','white',{promotion:'pawn',stage:0}]],'3,8','3,9','Redeployment is optional and uses a turn; ordinary moves remain available. It may replace a friendly or enemy piece except a reigning royal or enemy immune dormant pawn. On its second arrival it returns to the king-pawn home square, then on its third it becomes an adventitious king.'),
  {...exercise('deployment','15 / An optional fork','A dormant pawn-of-pawns may redeploy when a qualifying square is available, but you may instead make an ordinary move. White pawns attack diagonally toward increasing ranks.','Choose redeployment: place the pawn on f5 to fork both black rooks.',[['2,9','pawn','white',{promotion:'pawn',stage:1,dormant:true}],['4,5','rook','black'],['6,5','rook','black']],'2,9','5,4','This optional action spends the turn. It may replace a friendly or enemy piece, including a surplus lower royal, but never a reigning royal or enemy immune dormant pawn. Deployment onto the far rank is not a new arrival. The pawn can capture only on a later turn.'), accepts:move=>move.kind==='deploy' && move.to==='5,4'},
  exercise('second-return','16 / Return and rebirth','After deployment, the pawn-of-pawns journeys to the far rank again. It returns to f3 for White or f8 for Black, the original king-pawn square.','Advance the stage-one pawn from d9 to d10.',[['3,8','pawn','white',{promotion:'pawn',stage:1,dormant:false}]],'3,8','3,9','A non-royal on the return square is removed. The source does not specify a royal occupant: this reconstruction waits until that square is free of royals, rather than destroying one.'),
  exercise('adventitious','17 / The third arrival','On its third far-rank arrival, the pawn-of-pawns becomes an adventitious king, the lowest-ranked royal.','Advance the stage-two pawn from d9 to d10.',[['3,8','pawn','white',{promotion:'pawn',stage:2}]],'3,8','3,9','King outranks prince, which outranks adventitious king. The adventitious king alone can shelter in its own citadel. If it becomes your only royal there, you must choose a safe empty main-board square for its free return.'),
  {
    id:'stalemate',title:'18 / No way out',
    text:'Stalemate is a loss, not a draw. Black’s last king is on a10. Your king guards b9; your rook can seal the remaining exits without giving check.',
    task:'Move the rook from b7 to b9 to win by stalemate.',
    explanation:'The rook on b9 controls a9 and b10. Black cannot capture it because the white king on c8 protects b9. The king on a10 is not in check, but has no legal move: in this game, that loses.',
    createState:()=>{
      const state=position([['2,7','king'],['0,9','king','black'],['1,6','rook']]);
      delete state.board['0,0'];
      delete state.board['10,9'];
      return state;
    },
    accepts:move=>move.from==='1,6' && move.to==='1,8'
  },
  {
    id:'royal-return',title:'19 / Leave the shelter',
    text:'Black has just captured White’s other royal on c1. White’s sheltered adventitious king is now its only royal, so White—not the opponent—chooses its return square.',
    task:'Click any marked safe empty main-board square, or use a “Return adventitious king” button below the board.',
    explanation:'Hans Bodlaender explicitly invented this completion; it is not historical evidence. The owner freely chooses an empty main-board square, applying ordinary last-royal safety. The return spends no turn or ply: after this Black capture, White still makes its normal move. If no safe empty square exists, the owner loses.',
    createState:()=>{
      const state=position([['2,0','king'],['11,1','adventitious'],['2,2','rook','black']],{turn:'black'});
      delete state.board['0,0'];
      return applyMove(state,{from:'2,2',to:'2,0',kind:'move'});
    },
    accepts:(move,before,after)=>move.kind==='royal-return' && before.pendingRoyalReturn?.color==='white' && !after.pendingRoyalReturn && after.ply===before.ply && after.turn===before.pendingRoyalReturn.resumeTurn
  }
];
