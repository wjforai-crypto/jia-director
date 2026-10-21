from pathlib import Path
from playwright.sync_api import sync_playwright
from .core import config

def browser_probe():
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=config()['render']['browserPath'],headless=True)
        page=browser.new_page()
        result=page.evaluate('''() => {
          const c=document.createElement('canvas');c.width=c.height=8;
          const x=c.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,8,8);
          const pixel=[...x.getImageData(0,0,1,1).data];
          const g=document.createElement('canvas');g.width=g.height=8;
          const gl=g.getContext('webgl2');if(!gl)return {canvas2d:pixel[0]===255,webgl2:false};
          const shader=(kind,src)=>{const s=gl.createShader(kind);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
          const pr=gl.createProgram();gl.attachShader(pr,shader(gl.VERTEX_SHADER,'#version 300 es\\nvoid main(){vec2 v=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(v*2.0-1.0,0,1);}'));
          gl.attachShader(pr,shader(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision mediump float;out vec4 color;void main(){color=vec4(0,1,0,1);}'));
          gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(pr));
          gl.useProgram(pr);gl.drawArrays(gl.TRIANGLES,0,3);const b=new Uint8Array(4);gl.readPixels(4,4,1,1,gl.RGBA,gl.UNSIGNED_BYTE,b);
          const debug=gl.getExtension('WEBGL_debug_renderer_info');const renderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
          return {canvas2d:pixel[0]===255&&pixel[3]===255,webgl2:true,shaderPixel:[...b],shaderPassed:b[1]===255&&b[3]===255,renderer,softwareRenderer:/swiftshader|llvmpipe|software/i.test(renderer)};
        }''')
        browser.close()
        return result
