// =============================================================================
// TUTORIAL MAP DATA — embedded for the offline first-open tutorial
// -----------------------------------------------------------------------------
// Vite's `?raw` import turns the dedicated CSV file into a string at build time.
// The production app remains one offline HTML file, while the editable source of
// truth stays in assets/data/tutorial_map.csv rather than being duplicated here.
// =============================================================================

import tutorialMapCsv from "../data/tutorial_map.csv?raw";

export const TUTORIAL_MAP_CSV = tutorialMapCsv;

// The first lessons run on a twelve-box cut of the same programme, small enough
// to hold on one screen. Same file, same parser, same `?raw` route as above.
import tutorialMapSmallCsv from "../data/tutorial_map_small.csv?raw";

export const TUTORIAL_MAP_SMALL_CSV = tutorialMapSmallCsv;
