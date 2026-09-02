import { z } from 'zod';

export const STORY_TITLE_MAX_WORDS = 8;
export const STORY_TITLE_MAX_CODE_POINTS = 120;

export const countStoryTitleWords = (title: string): number =>
  title.trim().split(/\s+/u).filter(Boolean).length;

/** The one title contract shared by authored input and installed Story v3 data. */
export const storyTitleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((title) => countStoryTitleWords(title) <= STORY_TITLE_MAX_WORDS, {
    message: `Story title must contain at most ${STORY_TITLE_MAX_WORDS} words`,
  })
  .refine((title) => [...title].length <= STORY_TITLE_MAX_CODE_POINTS, {
    message: `Story title must contain at most ${STORY_TITLE_MAX_CODE_POINTS} Unicode code points`,
  });
