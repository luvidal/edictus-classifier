/**
 * @jogi/classifier - lean prompt-first document classifier.
 *
 * One Gemini call sees the whole file and returns final segments. Local code
 * only does geometry cleanup: duplicate collapse, exact same-range conflict
 * resolution, and PDF gap fill. No local OCR, anchors, page ledger, or doctype
 * detector.
 */
interface Doctype {
    label: string;
    definition?: string;
    dateHint?: string;
    freq?: 'once' | 'monthly' | 'annual';
    contains?: string[];
}
type DoctypesMap = Record<string, Doctype>;
interface Segment {
    id: string;
    start?: number;
    end?: number;
    confidence: number;
    docdate?: string | null;
    partId?: 'front' | 'back';
}
interface ClassifyOptions {
    candidateIds?: string[];
    model?: string;
}
type GeminiCall = (params: {
    model: string;
    contents: any;
    config?: any;
}) => Promise<any>;
interface ClassifierConfig {
    doctypes: DoctypesMap;
    geminiCall: GeminiCall;
}
declare function configure(c: ClassifierConfig): void;
declare function getDoctypesMap(): DoctypesMap;
declare function getDoctypes(): Array<Doctype & {
    id: string;
}>;
declare const NO_CLASIFICADO = "no-clasificado";
declare function classify(buffer: Buffer, mimetype: string, opts?: ClassifyOptions): Promise<Segment[]>;

export { type ClassifierConfig, type ClassifyOptions, type Doctype, type DoctypesMap, type GeminiCall, NO_CLASIFICADO, type Segment, classify, configure, getDoctypes, getDoctypesMap };
