/**
 * @edictus/classifier - lean prompt-first document classifier.
 *
 * One Gemini call sees the whole file and returns final segments. Local code
 * only does geometry cleanup: duplicate collapse, exact same-range conflict
 * resolution, blank-page range attachment, and PDF gap fill. No local OCR,
 * anchors, page ledger, or doctype detector.
 */
/**
 * Structured classification hints for a doctype. Authored in the host's
 * `doctypes.yaml`; rendered as telegraphic bullets by `promptFor()`. Reciprocity
 * of `tieBreaker` is guaranteed by the host build (`build-doctypes.ts` mirrors
 * each pair); boot validation here re-checks it as defense-in-depth.
 */
interface DoctypeClassifier {
    useWhen: string[];
    signals: string[];
    rejectWhen: string[];
    tieBreaker: Array<{
        vs: string;
        rule: string;
    }>;
}
interface Doctype {
    label: string;
    definition?: string;
    dateHint?: string;
    freq?: 'once' | 'monthly' | 'annual';
    contains?: string[];
    classifier?: DoctypeClassifier;
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
declare function getClassifierFingerprint(): string;
declare function getClassifierProfile(): {
    model: string;
};

export { type ClassifierConfig, type ClassifyOptions, type Doctype, type DoctypeClassifier, type DoctypesMap, type GeminiCall, NO_CLASIFICADO, type Segment, classify, configure, getClassifierFingerprint, getClassifierProfile, getDoctypes, getDoctypesMap };
