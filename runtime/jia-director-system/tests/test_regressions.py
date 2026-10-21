import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from jia_director.core import directory_binding,verify_binding,write_json
from jia_director.storyboard import numeric_tokens
from jia_director.voice import compile_cues
from tests import test_voice_delivery as delivery_tests

class BoundaryTests(unittest.TestCase):
    def test_full_amount_tokens(self):
        self.assertNotEqual(numeric_tokens('500万'),numeric_tokens('1500万'))
        self.assertNotEqual(numeric_tokens('500万'),numeric_tokens('500元'))
        self.assertEqual(numeric_tokens('500万'),numeric_tokens('五百万'))
        self.assertEqual(numeric_tokens('五百万元'),numeric_tokens('500万元'))
        self.assertEqual(numeric_tokens('一亿五千万元'),numeric_tokens('150000000元'))
        self.assertEqual(numeric_tokens('百分之五十'),numeric_tokens('50%'))
        self.assertEqual(numeric_tokens('十五点五元'),numeric_tokens('15.5元'))
    def test_frame_directory_detects_additions_and_changes(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'001.png').write_bytes(b'first');b=directory_binding(p);verify_binding(b)
            (p/'002.png').write_bytes(b'added')
            with self.assertRaisesRegex(ValueError,'changed'):verify_binding(b)
            (p/'002.png').unlink();(p/'001.png').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'changed'):verify_binding(b)
    def test_word_rounding_must_have_a_frame(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            for name,data in [('words.json',[{'text':'尾','start':3.99,'end':4}]),('map.json',[{'keyword':'尾','cueIndex':0}]),('spec.json',{'grammar':'y3_whiteboard','duration':4,'fps':30,'cues':[{'at':0,'kind':'draw','text':'尾','data':{'icon':'doc'}}]})]:write_json(p/name,data)
            (p/'a.wav').write_bytes(b'not decoded in this unit fixture')
            with patch('jia_director.voice.run',return_value={'stdout':'{"format":{"duration":"4"}}'}):
                with self.assertRaisesRegex(ValueError,'no output frame'):compile_cues(p/'words.json',p/'a.wav',p/'spec.json',p/'map.json',p/'out')

class DeliveryRegressionTests(unittest.TestCase):
    setUp=delivery_tests.DeliveryTests.setUp
    save=delivery_tests.DeliveryTests.save
    def test_non_structured_coverage_rejected(self):
        self.review['coverage']='yes';self.save()
        with self.assertRaisesRegex(ValueError,'coverage'):self.call()
    def call(self):
        from jia_director.delivery import validate_delivery
        return validate_delivery(self.video,self.qa_path,self.review_path)
    def test_false_resolution_rejected(self):
        self.review['findings']=[{'status':'resolved'}];self.save()
        with self.assertRaisesRegex(ValueError,'require'):self.call()
    def test_yellow_whitespace_is_not_a_decision(self):
        self.qa['warnings']=['motion'];self.review['warningDecisions']=[{'warning':'motion','reason':' '}];self.save()
        with self.assertRaisesRegex(ValueError,'Yellow'):self.call()

if __name__=='__main__':unittest.main()
