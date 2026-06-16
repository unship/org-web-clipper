import { describe, it, expect } from 'vitest';
import {
  parseClock,
  activeFraction,
  interpVectors,
  parseNums,
  buildValueVectors,
  transformToString,
  isSmilTag,
} from './svg-smil';

describe('parseClock', () => {
  it('parses seconds with and without unit', () => {
    expect(parseClock('1.6s')).toBeCloseTo(1.6);
    expect(parseClock('2')).toBeCloseTo(2);
  });

  it('parses millisecond, minute and hour units', () => {
    expect(parseClock('300ms')).toBeCloseTo(0.3);
    expect(parseClock('2min')).toBeCloseTo(120);
    expect(parseClock('1h')).toBeCloseTo(3600);
  });

  it('parses colon clock values (mm:ss and hh:mm:ss)', () => {
    expect(parseClock('1:30')).toBeCloseTo(90);
    expect(parseClock('01:00:00')).toBeCloseTo(3600);
  });

  it('returns null for empty, missing, or event-based values', () => {
    expect(parseClock(null)).toBeNull();
    expect(parseClock('')).toBeNull();
    expect(parseClock('indefinite')).toBeNull();
    expect(parseClock('click+1s')).toBeNull();
  });
});

describe('activeFraction', () => {
  it('returns null before begin', () => {
    expect(activeFraction(0.5, { begin: 1, dur: 2 })).toBeNull();
  });

  it('returns the within-iteration fraction during play', () => {
    expect(activeFraction(1.5, { begin: 0, dur: 2 })).toBeCloseTo(0.75);
  });

  it('loops with indefinite repeat', () => {
    // dur 2, t=5 → 5 % 2 = 1 → fraction 0.5
    expect(activeFraction(5, { begin: 0, dur: 2, repeatCount: 'indefinite' })).toBeCloseTo(0.5);
  });

  it('honours begin offset under indefinite repeat', () => {
    // begin 0.8, dur 1.6, t=0.8 → local 0 → fraction 0
    expect(activeFraction(0.8, { begin: 0.8, dur: 1.6, repeatCount: 'indefinite' })).toBeCloseTo(0);
  });

  it('returns null after a single non-frozen play', () => {
    expect(activeFraction(3, { begin: 0, dur: 2 })).toBeNull();
  });

  it('freezes at the final frame when fill=freeze', () => {
    expect(activeFraction(3, { begin: 0, dur: 2, fill: 'freeze' })).toBe(1);
  });

  it('stops after a finite repeatCount', () => {
    // 2 reps of dur 2 = active in [0,4); t=5 → inactive
    expect(activeFraction(5, { begin: 0, dur: 2, repeatCount: 2 })).toBeNull();
    expect(activeFraction(3, { begin: 0, dur: 2, repeatCount: 2 })).toBeCloseTo(0.5);
  });

  it('returns null for non-positive duration', () => {
    expect(activeFraction(1, { begin: 0, dur: 0 })).toBeNull();
  });
});

describe('parseNums', () => {
  it('splits on whitespace and commas', () => {
    expect(parseNums('0 10 3')).toEqual([0, 10, 3]);
    expect(parseNums('1,2')).toEqual([1, 2]);
    expect(parseNums(' 1.5 , -2 ')).toEqual([1.5, -2]);
  });
});

describe('buildValueVectors', () => {
  it('parses a semicolon-separated values list into vectors', () => {
    expect(buildValueVectors({ values: '0 0; 10 20; 5 5' })).toEqual([[0, 0], [10, 20], [5, 5]]);
  });

  it('builds a two-stop list from from/to', () => {
    expect(buildValueVectors({ from: '0', to: '90' })).toEqual([[0], [90]]);
  });

  it('returns null when neither values nor from/to are usable', () => {
    expect(buildValueVectors({ by: '5' })).toBeNull();
    expect(buildValueVectors({})).toBeNull();
  });
});

describe('interpVectors', () => {
  it('returns the single vector when only one is given', () => {
    expect(interpVectors([[5, 5]], null, 0.7)).toEqual([5, 5]);
  });

  it('linearly interpolates between two vectors at uniform timing', () => {
    expect(interpVectors([[0, 0], [10, 20]], null, 0.5)).toEqual([5, 10]);
  });

  it('uses keyTimes to control the timing of segments', () => {
    // keyTimes [0,0.25,1]: at f=0.25 we are exactly at the middle vector
    const v = interpVectors([[0], [100], [200]], [0, 0.25, 1], 0.25);
    expect(v[0]).toBeCloseTo(100);
    // halfway through the long second segment (f between 0.25 and 1)
    const v2 = interpVectors([[0], [100], [200]], [0, 0.25, 1], 0.625);
    expect(v2[0]).toBeCloseTo(150);
  });

  it('clamps the fraction to [0,1]', () => {
    expect(interpVectors([[0], [10]], null, 2)[0]).toBeCloseTo(10);
    expect(interpVectors([[0], [10]], null, -1)[0]).toBeCloseTo(0);
  });
});

describe('transformToString', () => {
  it('formats translate, rotate and scale', () => {
    expect(transformToString('translate', [3, 4])).toBe('translate(3 4)');
    expect(transformToString('rotate', [45, 10, 20])).toBe('rotate(45 10 20)');
    expect(transformToString('scale', [2])).toBe('scale(2 2)');
  });
});

describe('isSmilTag', () => {
  it('recognises SMIL animation element tag names case-insensitively', () => {
    expect(isSmilTag('animateMotion')).toBe(true);
    expect(isSmilTag('animateTransform')).toBe(true);
    expect(isSmilTag('animate')).toBe(true);
    expect(isSmilTag('set')).toBe(true);
    expect(isSmilTag('rect')).toBe(false);
  });
});
