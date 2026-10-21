import copy
from pathlib import Path
import tempfile
import unittest

from jia_director.core import binding,write_json,sha256
from jia_director.voice import normalize_words,keyword_interval,compile_cues
from jia_director.delivery import validate_delivery

class VoiceTests(unittest.TestCase):
    def setUp(self):self.words=[{'text':'给孩子','start':0,'end':.5},{'text':'留','start':.5,'end':.7},{'text':'500','start':.7,'end':1.2},{'text':'万','start':1.2,'end':1.4}]
    def test_keyword_spans_asr_tokens(self):
        r=keyword_interval(self.words,'500万');self.assertEqual((r['start'],r['end']),(.7,1.4))
    def test_unknown_keyword_is_not_estimated(self):
        with self.assertRaisesRegex(ValueError,'absent'):keyword_interval(self.words,'1000万')
    def test_repeated_keyword_is_not_silently_first(self):
        with self.assertRaisesRegex(ValueError,'Ambiguous'):keyword_interval(self.words+self.words,'500万')
    def test_explicit_occurrence(self):self.assertEqual(keyword_interval(self.words+self.words,'500万',1)['firstToken'],6)
    def test_nonfinite_time(self):
        self.words[0]['start']=float('nan')
        with self.assertRaises(ValueError):normalize_words(self.words)
    def test_reversed_time(self):
        self.words[1]['end']=0
        with self.assertRaises(ValueError):normalize_words(self.words)
    def test_whisper_special_tokens_not_visible_words(self):
        words,kind=normalize_words({'transcription':[{'tokens':[{'text':'[_BEG_]','offsets':{'from':0,'to':0}},{'text':'孩子','offsets':{'from':200,'to':600}}]}]})
        self.assertEqual(len(words),1);self.assertEqual(words[0]['start'],.2);self.assertEqual(kind,'ASR-token-offsets')

class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.video=self.root/'test.mp4';self.video.write_bytes(b'unit-fixture-not-media')
        self.source=self.root/'scene.js';self.source.write_text('source-v1')
        self.spec=self.root/'spec.json';self.spec.write_text('{}')
        self.gate=self.root/'gate.json';self.gate.write_text('{}')
        self.algorithm=self.root/'gate.py';self.algorithm.write_text('# algorithm fixture')
        self.qa_path=self.root/'qa.json';self.review_path=self.root/'review.json'
        self.qa={'kind':'jia-final-qa','status':'passed','media':{'file':binding(self.video)},'source':{'files':[binding(self.source)],'sha256':'source-tree-fixture'},'inputs':[binding(self.spec)],'algorithm':binding(self.algorithm),'filmGate':binding(self.gate),'warnings':[]}
        self.review={'kind':'independent-review','reviewer':'unit-test-fixture','status':'passed','coverage':[{'from':0,'to':1,'mode':'test-only'}],'findings':[],'videoSha256':sha256(self.video),'qaSha256':'','sourceSha256':'source-tree-fixture','userAccepted':False}
        self.save()
    def save(self):
        write_json(self.qa_path,self.qa);self.review['qaSha256']=sha256(self.qa_path);write_json(self.review_path,self.review)
    def test_matching_evidence_contract(self):self.assertEqual(validate_delivery(self.video,self.qa_path,self.review_path)[0]['status'],'passed')
    def test_failed_qa_rejected(self):
        self.qa['status']='failed';self.save()
        with self.assertRaisesRegex(ValueError,'not passed'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_changed_video_rejected(self):
        self.video.write_bytes(b'other version')
        with self.assertRaisesRegex(ValueError,'changed evidence'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_changed_source_rejected(self):
        self.source.write_text('source-v2')
        with self.assertRaisesRegex(ValueError,'changed evidence'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_changed_spec_rejected(self):
        self.spec.write_text('{"new":true}')
        with self.assertRaisesRegex(ValueError,'changed evidence'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_changed_qa_requires_new_review(self):
        self.qa['warnings']=['new warning'];write_json(self.qa_path,self.qa)
        with self.assertRaisesRegex(ValueError,'stale QA'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_file_exists_is_not_review_pass(self):
        self.review['status']='pending';self.save()
        with self.assertRaisesRegex(ValueError,'review has not passed'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_unresolved_finding_blocks(self):
        self.review['findings']=[{'status':'open','issue':'bad action'}];self.save()
        with self.assertRaisesRegex(ValueError,'unresolved'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_yellow_requires_reason(self):
        self.qa['warnings']=['near threshold'];self.save()
        with self.assertRaisesRegex(ValueError,'Yellow-light'):validate_delivery(self.video,self.qa_path,self.review_path)
    def test_agent_cannot_accept_for_user(self):
        self.review['userAccepted']=True;self.save()
        with self.assertRaisesRegex(ValueError,'cannot grant'):validate_delivery(self.video,self.qa_path,self.review_path)

if __name__=='__main__':unittest.main()
