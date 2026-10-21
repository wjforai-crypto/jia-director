import copy
import tempfile
import unittest
from pathlib import Path

from jia_director.clip import validate_spec
from jia_director.storyboard import lint_storyboard

class SpecTests(unittest.TestCase):
    def setUp(self):
        self.spec={'grammar':'y3_whiteboard','duration':4,'width':640,'height':360,'fps':30,'theme':'paper','cues':[{'at':0,'kind':'draw','text':'时钟','data':{'icon':'clock'}}]}

    def test_valid(self):self.assertEqual(validate_spec(self.spec,Path.cwd())['fps'],30)
    def test_misspelled_top_level(self):
        self.spec['camera']='snap'
        with self.assertRaisesRegex(ValueError,'Unknown spec'):validate_spec(self.spec,Path.cwd())
    def test_misspelled_nested_field(self):
        self.spec['cues'][0]['data']['indx']=0
        with self.assertRaisesRegex(ValueError,'Unknown cue data'):validate_spec(self.spec,Path.cwd())
    def test_cue_at_end(self):
        self.spec['cues'][0]['at']=4
        with self.assertRaisesRegex(ValueError,'before clip end'):validate_spec(self.spec,Path.cwd())
    def test_missing_local_asset(self):
        self.spec['cues'][0]['image']='missing.png'
        with self.assertRaisesRegex(ValueError,'Missing asset'):validate_spec(self.spec,Path.cwd())
    def test_external_asset_rejected(self):
        self.spec['cues'][0]['image']='https://example.com/remote.png'
        with self.assertRaisesRegex(ValueError,'local file'):validate_spec(self.spec,Path.cwd())
    def test_long_clip_rejected(self):
        self.spec['duration']=9
        with self.assertRaisesRegex(ValueError,'H10'):validate_spec(self.spec,Path.cwd())
    def test_boolean_dimension_rejected(self):
        self.spec['width']=True
        with self.assertRaises(ValueError):validate_spec(self.spec,Path.cwd())
    def test_nan_rejected(self):
        self.spec['duration']=float('nan')
        with self.assertRaises(ValueError):validate_spec(self.spec,Path.cwd())

class StoryboardTests(unittest.TestCase):
    def setUp(self):
        self.board={'style':'paper explanation','palette':'paper','character':{'mode':'hands'},'example':'存钱罐','tier':'track','newDirection':False,'duration':6,'shots':[{'id':'S01','start':0,'end':3,'background':'书桌','objects':['存钱罐','硬币'],'action':{'from':'空罐','verb':'硬币落入罐内','to':'罐中有硬币'},'camera':'固定','text':'先放一枚','method':'y3_whiteboard'},{'id':'S02','start':3,'end':6,'background':'书桌','objects':['存钱罐','手'],'action':{'from':'罐敞开','verb':'手合上盖子','to':'罐盖闭合'},'camera':'拉远','text':'留给以后','method':'y3_whiteboard'}]}
    def test_valid(self):self.assertEqual(lint_storyboard(self.board)['status'],'passed')
    def test_background_missing(self):
        self.board['shots'][0]['background']=''
        self.assertTrue(lint_storyboard(self.board)['red'])
    def test_weak_action(self):
        self.board['shots'][0]['action']['verb']='展示'
        self.assertIn('generic',str(lint_storyboard(self.board)['red']))
    def test_overlap(self):
        self.board['shots'][1]['start']=2.5
        self.assertIn('overlap',str(lint_storyboard(self.board)['red']))
    def test_number_mismatch(self):
        self.board['shots'][0]['text']='500万'
        self.assertIn('absent',str(lint_storyboard(self.board,'给孩子留一笔钱')['red']))
    def test_new_direction_requires_human(self):
        self.board['newDirection']=True
        self.assertTrue(lint_storyboard(self.board)['requiresHumanDirectionSelection'])
    def test_approved_blue_purple_is_recorded(self):
        self.board['palette']=['#7733aa'];self.board['allowBluePurple']='用户明确指定测试此配色'
        r=lint_storyboard(self.board)
        self.assertEqual(r['status'],'passed');self.assertTrue(r['yellow'])
    def test_character_exception_narrow(self):
        self.board['character']={'mode':'svg-flat'}
        self.assertIn('exception',str(lint_storyboard(self.board)['red']))

if __name__=='__main__':unittest.main()
