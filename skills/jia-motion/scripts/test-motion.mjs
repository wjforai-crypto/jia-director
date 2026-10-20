import assert from 'node:assert/strict';
import {springState,retarget,hermite} from '../assets/motion.mjs';

let checks=0;
function close(a,b,tol=1e-5){assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);checks++;}
for(const damping of [.25,.75,1,1.4]){
  const opt={from:-20,to:60,velocity:17,frequency:2.2,damping};
  close(springState(0,opt).value,-20);close(springState(0,opt).velocity,17);
  for(const t of [.08,.4,.9]){
    const h=1e-6,numeric=(springState(t+h,opt).value-springState(t-h,opt).value)/(2*h);
    close(springState(t,opt).velocity,numeric,1e-4);
  }
  close(springState(20,opt).value,60);
}
const changes=[{time:.1,target:640},{time:.28,target:400},{time:.6,target:720}];
for(const {time} of changes){
  const eps=1e-8,a=retarget(time-eps,100,changes),b=retarget(time+eps,100,changes);
  close(a.value,b.value,1e-3);close(a.velocity,b.velocity,1e-2);
}
const ordered=[0,.05,.2,.3,.8,1.2,3].map(t=>retarget(t,100,changes));
for(const i of [5,2,6,0,3,1,4])assert.deepEqual(retarget([0,.05,.2,.3,.8,1.2,3][i],100,changes),ordered[i]);
checks+=7;
close(hermite(0,2,10,70,4,-3),10);close(hermite(2,2,10,70,4,-3),70);
const h=1e-6;
close((hermite(h,2,10,70,4,-3)-10)/h,4,1e-3);
close((70-hermite(2-h,2,10,70,4,-3))/h,-3,1e-3);
assert.throws(()=>retarget(1,0,[{time:1,target:2},{time:0,target:1}]));checks++;
console.log(JSON.stringify({passed:true,checks,scope:'Analytic derivatives, C1 retarget continuity, random-order evaluation and Hermite endpoints; not aesthetic acceptance.'}));
