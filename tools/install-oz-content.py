"""Add the aligned first Oz chapter to the mini program's JSON content."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
content = ROOT / 'modules/listen-read/content'
source = json.loads((ROOT / 'tools/oz-source.json').read_text(encoding='utf-8'))
alignment = json.loads((ROOT / 'tools/oz-alignment-review.json').read_text(encoding='utf-8'))

stories_file = content / 'stories.json'
stories = json.loads(stories_file.read_text(encoding='utf-8'))
chapter = {
    'id': 'oz-1', 'title': 'The Cyclone', 'zh': '第一章：旋风',
    'audio': '/assets/audio/oz-1.mp3',
    'sentences': [['Chapter I. The Cyclone.', '']] + [[s, ''] for s in source['sentences']],
    'quiz': [],
}
book = {
    'id': 'wonderful-wizard-oz', 'title': 'The Wonderful Wizard of Oz',
    'zh': '绿野仙踪', 'subtitle': '跟着原声朗读，走进奥兹国',
    'level': 'L2', 'levelName': '进阶阅读', 'age': '亲子共读',
    'theme': '奇幻', 'color': '#E6E9D8', 'price': '0.00',
    'free': True, 'hasTranslation': False, 'hasQuiz': False, 'hasDictionary': True,
    'sourceCredit': 'L. Frank Baum 原著 · Project Gutenberg 文本 · LibriVox 朗读',
    'intro': '本次收录第一章《The Cyclone》。跟着朗读认识 Dorothy 和 Toto，逐句阅读故事原文。',
    'focus': '英文原著 · 原声朗读 · 逐句跟读',
    'tags': ['英文原著', '原声朗读', '第一章'],
    'chapters': [chapter], 'cover': '/assets/covers/wonderful-wizard-oz.jpg',
}
stories['books'] = [b for b in stories['books'] if b['id'] != book['id']] + [book]
stories_file.write_text(json.dumps(stories, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

timings_file = content / 'timings.json'
timings = json.loads(timings_file.read_text(encoding='utf-8'))
timings['oz-1'] = {
    'duration': 384.63,
    'cues': [{key: alignment['title'][key] for key in ('start', 'end')}]
    + [{key: cue[key] for key in ('start', 'end')} for cue in alignment['cues']],
}
timings_file.write_text(json.dumps(timings, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('Installed Oz chapter with', len(timings['oz-1']['cues']), 'timed lines')
