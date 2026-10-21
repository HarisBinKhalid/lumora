const chk = (...v) => { for (const x of v) if (!Number.isFinite(x)) throw new Error('non-finite ' + v); };
class Grad { constructor(make){ this.make = make; this.stops=[]; }
  addColorStopRGBA(o,r,g,b,a){ chk(o,r,g,b,a); this.stops.push([Math.max(0,Math.min(1,o)),`rgba(${r*255|0},${g*255|0},${b*255|0},${Math.max(0,Math.min(1,a))})`]); } }
export default {
  LineCap:{ROUND:'round',BUTT:'butt'}, LineJoin:{ROUND:'round'}, Operator:{CLEAR:0,OVER:1},
  RadialGradient: class extends Grad { constructor(x0,y0,r0,x1,y1,r1){ chk(x0,y0,r0,x1,y1,r1); super(c=>c.createRadialGradient(x0,y0,r0,x1,y1,r1)); } },
  LinearGradient: class extends Grad { constructor(x0,y0,x1,y1){ chk(x0,y0,x1,y1); super(c=>c.createLinearGradient(x0,y0,x1,y1)); } },
};
export function wrap(c) {
  return {
    save(){c.save()}, restore(){c.restore()},
    translate(x,y){chk(x,y);c.translate(x,y)}, rotate(a){chk(a);c.rotate(a)}, scale(x,y){chk(x,y);c.scale(x,y)},
    moveTo(x,y){chk(x,y);c.moveTo(x,y)}, lineTo(x,y){chk(x,y);c.lineTo(x,y)},
    curveTo(a,b,d,e,f,g){chk(a,b,d,e,f,g);c.bezierCurveTo(a,b,d,e,f,g)},
    arc(x,y,r,a,b){chk(x,y,r,a,b); c.arc(x,y,Math.max(0,r),a,b)}, rectangle(x,y,w,h){chk(x,y,w,h);c.rect(x,y,w,h)},
    closePath(){c.closePath()},
    setOperator(op){this._op=op}, paint(){ if(this._op===0){ c.save(); c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,c.canvas.width,c.canvas.height); c.restore(); } }, $dispose(){},
    setLineWidth(w){chk(w);c.lineWidth=w}, setLineCap(v){c.lineCap=v}, setLineJoin(v){c.lineJoin=v},
    setSourceRGBA(r,g,b,a){chk(r,g,b,a); const s=`rgba(${r*255|0},${g*255|0},${b*255|0},${Math.max(0,Math.min(1,a))})`; c.fillStyle=s; c.strokeStyle=s},
    setSource(g){const gr=g.make(c); for(const [o,s] of g.stops) gr.addColorStop(o,s); c.fillStyle=gr; c.strokeStyle=gr},
    fill(){c.fill();c.beginPath()}, clip(){c.clip();c.beginPath()}, fillPreserve(){c.fill()}, stroke(){c.stroke();c.beginPath()},
  };
}
