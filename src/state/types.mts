import type {BoardRepository} from './board.mjs';
/** The admitted board repository is separate from raw content and other legacy state. */
export interface ApplicationState {readonly namespace:string; readonly board:BoardRepository;}
