import type { StopWordLanguage } from '@app/specs/seo-content.spec';

// frost's stop-word lists (spec `seo-content.spec.ts`, `STOP_WORD_LANGUAGES`): small lists of the
// most common function words of each language (articles, pronouns, prepositions, conjunctions,
// auxiliaries, a few adverbs), written for frost. They only keep such words from the edges of
// n-grams and out of target query terms; nothing is scored on them. Lowercase, NFKC.

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter((word) => word !== ''));

export const STOP_WORDS: Readonly<Record<StopWordLanguage, ReadonlySet<string>>> = {
  en: words(`
    a about above after again against all also am an and any are aren't as at be because been before being below between both but by
    can can't cannot could couldn't did didn't do does doesn't doing don't down during each either even ever every few for from further
    get gets got had hadn't has hasn't have haven't having he her here hers herself him himself his how however i i'm if in into is isn't
    it it's its itself just let's may me might more most much must my myself neither no nor not now of off on once one only or other our
    ours ourselves out over own per same shall she should shouldn't so some such than that that's the their theirs them themselves then
    there there's these they they're this those though through to too under until up upon us very via was wasn't we we're were weren't
    what what's when where which while who whom whose why will with within without won't would wouldn't yet you you're your yours
    yourself yourselves
  `),
  es: words(`
    a al algo algunas algunos ante antes aquel aquella aquellas aquellos aqui aquí así como con contra cual cuales cuando de del desde donde
    dos el él ella ellas ellos en entre era eran es esa esas ese eso esos esta está están estas este esto estos fue fueron ha hace hacia
    han hasta hay la las le les lo los más me mi mis mucho muy nada ni no nos nosotros nuestra nuestro o otra otras otro otros para pero
    poco por porque que qué quien quién se sea sean según ser si sí sin sobre son su sus también tan te tiene tienen todo todos tu tus
    un una unas uno unos usted ustedes y ya yo
  `),
  fr: words(`
    à afin ai aie alors au aucun aussi autre aux avec avoir avant c ça car ce ceci cela celle celles celui ces cet cette chez comme
    comment d dans de des donc dont du elle elles en encore est et étaient était été être eu eux il ils j je l la le les leur leurs lui
    m ma mais me même mes moi mon n ne ni nos notre nous on ont ou où par pas peu peut plus pour pourquoi qu quand que quel quelle
    quelles quels qui s sa sans se ses si sien son sont sous sur t ta te tes toi ton tous tout toute toutes très tu un une vers vos
    votre vous y
  `),
  de: words(`
    aber alle allem allen aller alles als also am an andere anderen auch auf aus bei beim bin bis bist da damit dann das dass dein deine
    dem den denn der des dessen deshalb die dies diese diesem diesen dieser dieses doch dort du durch ein eine einem einen einer eines er
    es etwa euch euer für gegen hab habe haben hat hatte hier hin hinter ich ihm ihn ihnen ihr ihre im in ist ja jede jedem jeden jeder
    jedes jetzt kann kein keine können man mehr mein meine mit muss nach nicht nichts noch nun nur ob oder ohne sehr sein seine sich sie
    sind so soll sondern über um und uns unser unsere unter viel vom von vor war waren was weil welche welcher wenn wer werden wie wir
    wird wo zu zum zur zwischen
  `),
};
