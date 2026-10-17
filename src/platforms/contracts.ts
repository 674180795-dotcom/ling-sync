import type { Account, ContentDraft, Evidence, PlatformId, PublishTask, VideoMetadata } from '../core/model';

export type EditorObservation = { title: string; bodyMatched: boolean; formatMatched:boolean; bodyDigest:string; mediaCount: number; imageItems?:number; remoteMediaReady?:boolean; uploadBusy?:boolean; mediaHashes: string[]; editorFound: boolean; login: 'connected' | 'logged_out' | 'unknown'; label?: string; notice?: string;fieldState?:{actualCharacters:number;expectedCharacters:number;nativeCharacters?:number;modelMatched:boolean} };
export type BridgeCommand = { operation: 'detect' | 'open_editor' | 'reopen_draft' | 'prepare_fill' | 'fill' | 'read' | 'save' | 'upload_begin' | 'upload_chunk' | 'upload_commit'; taskId: string; attemptId: string; platform: PlatformId; targetId?:string; proof?:PublishTask['proof']; title?: string; markdown?: string; html?: string; expectedBody?: string; mediaCount?: number; media?: { id: string; name: string; mime: string; bytes: number }; chunk?: string; index?: number; };
export interface PlatformAdapter {
  detectSession(): Promise<Account>;
  validate(draft: ContentDraft, targetId: string): void;
  openEditor(task: PublishTask): Promise<number>;
  fillEditor(task: PublishTask, tabId: number): Promise<EditorObservation>;
  saveDraft(task: PublishTask): Promise<EditorObservation>;
  verifyDraft(task: PublishTask, readOnly?:boolean): Promise<Evidence>;
  recoverEditor?(task:PublishTask,videoMetadata?:VideoMetadata):Promise<{proof:NonNullable<PublishTask['proof']>;evidence:Evidence}>;
  preparePublication?(task:PublishTask):Promise<string>;
  publish?(task:PublishTask):Promise<Evidence>;
  verifyPublication?(task:PublishTask):Promise<Evidence>;
}
