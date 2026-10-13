import type { RtcSpeaker } from "./rtc-stt";

/**
 * Voice mode can ignore voices that are not enrolled ("Only enrolled voices", on by default).
 *
 * An utterance is dropped only when the portal is SURE it is a stranger: the verdict exists, was reached on a clip long
 * enough to carry weight (`reliable`) and matched none of the enrolled voices. No verdict (identification off, nobody
 * enrolled, the service down, a clip too short to judge) always lets the speech through, so a missing piece never
 * silences the owner; the cost is that a very short stranger's word can still get in.
 */
export const ignoredVoice = (filterOn: boolean, speaker: RtcSpeaker | undefined): boolean =>
  filterOn && !!speaker && speaker.reliable && !speaker.matched;
