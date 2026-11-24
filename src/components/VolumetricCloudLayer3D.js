const EARTH_C = 40075016.68557849
const UNIT_M = 6
const CLOUD_BASE_M = 65
const MIN_VISUAL_CLOUD_COVER = 0.35
const MAX_RENDER_SCALE = 0.4
const DEFAULT_FOV = 0.6435011087932844

const VERT = `
attribute vec2 a;
void main(){ gl_Position=vec4(a,0.,1.); }`

const COMMON = `
precision highp float;
uniform float uT,uCond,uCover;
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash(vec3 p){ p=fract(p*0.3183099+.1); p*=17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){
  vec3 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x), mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p,int o){
  float a=.5,s=0.,n=0.;
  for(int i=0;i<4;i++){ if(i>=o)break; s+=a*noise(p); n+=a; a*=.5; p=p*2.03+vec3(1.7,9.2,3.3); }
  return s/n;
}
float remap(float v,float a,float b,float c,float d){ return c+(v-a)/(b-a)*(d-c); }
void weather(vec2 w,out float cov,out float typ,out float dep,out float anv){
  anv=0.;
  float cd=uCond, dm=1.;
  bool over=(cd>1.5&&cd<3.5)||cd>4.5;
  float f=fbm(vec3(w*.03,4.),3);
  float thr=.66-.5*uCover;
  if(over){
    cov=.95*smoothstep(thr-.14,thr+.12,f);
    typ=cd<2.5?.1:.3;
    dep=3.2+3.2*fbm(vec3(w*.015,6.),2);
    if(cd>2.5&&cd<3.5) dm=1.3;
  } else {
    float cu=smoothstep(thr,thr+.2,f);
    cov=cu*.92; typ=1.;
    dep=2.8+2.5*cu+3.2*smoothstep(.6,.8,fbm(vec3(w*.011,6.),2));
    if(cd>3.5&&cd<4.5){ dm=1.4; cov=min(1.,cov*1.25); }
  }
  dep=min(dep*dm,10.);
  cov*=1.-smoothstep(215.,250.,max(abs(w.x),abs(w.y)));
}`

const BAKE_MAIN = `
void main(){
  vec2 w=(gl_FragCoord.xy/512.-.5)*512.;
  float cov,typ,dep,anv;
  weather(w,cov,typ,dep,anv);
  gl_FragColor=vec4(cov,typ,dep/32.,anv);
}`

const CLOUD_MAIN = `
uniform vec2 uRes,uTan;
uniform float uY0,uDark,uOver,uRain,uSnow,uFlash,uNight,uOpacity;
uniform vec3 uCam,uFw,uUp,uRt,uSun;
uniform sampler2D uTex,uWx;
vec3 SUN,SUNC,AMBSKY;
void wx(vec2 w,out float cov,out float typ,out float dep,out float anv){
  vec4 t=texture2D(uWx,w/512.+.5);
  cov=t.x; typ=t.y; dep=t.z*32.; anv=t.w;
}
vec4 tex3(vec3 p){
  p=fract(p);
  float z=p.z*48., zi=floor(z), fz=z-zi, zn=mod(zi+1.,48.);
  vec2 xy=p.xy*48.+1.5;
  vec2 o0=vec2(mod(zi,7.),floor(zi/7.))*50.;
  vec2 o1=vec2(mod(zn,7.),floor(zn/7.))*50.;
  return mix(texture2D(uTex,(o0+xy)/350.),texture2D(uTex,(o1+xy)/350.),fz);
}
float grad(float h,float t){
  float st=smoothstep(0.,.1,h)-smoothstep(.2,.3,h);
  float sc=smoothstep(.02,.2,h)-smoothstep(.48,.625,h);
  float cu=smoothstep(0.,.1625,h)-smoothstep(.88,.98,h);
  return mix(mix(st,sc,clamp(t*2.,0.,1.)),cu,clamp(t*2.-1.,0.,1.));
}
float shapeD(vec3 q,float g,float c,float hf,float da,float typ){
  vec4 n=tex3(q*(1./16.));
  vec4 m=tex3(vec3(q.x*.8+q.z*.6,q.y,q.z*.8-q.x*.6)*(1./37.)+vec3(.17,.43,.71));
  float k=mix(.3,1.,smoothstep(.1,.7,typ));
  float fl=n.g*.625+n.b*.25+n.a*.125;
  float b=clamp(mix(.62,mix(n.r,m.r,.45),k)+(fl-.48)*.6*k,0.,1.)*g;
  float ce=clamp(c*(.55+.9*m.g),0.,1.);
  b=clamp(remap(b,1.-ce,1.,0.,1.),0.,1.)*ce;
  if(da>0.&&b>0.){
    vec4 d=tex3(q*(1./6.)+vec3(.31,.17,.43));
    float f2=d.g*.625+d.b*.25+d.a*.125;
    float mm=mix(f2,1.-f2,clamp(hf*10.,0.,1.));
    b=clamp(remap(b,mm*.35*da,1.,0.,1.),0.,1.);
  }
  return clamp(b*1.8,0.,1.);
}
float densBL(vec3 q,float yl,float cov,float typ,float dep,float da){
  if(cov>.01&&yl>=0.&&yl<dep) return shapeD(q,grad(yl/dep,typ),cov,yl/dep,da,typ);
  return 0.;
}
vec3 nq(vec3 p){
  vec2 wp=vec2(noise(vec3(p.xz*.03,7.)),noise(vec3(p.xz*.03,13.)))*18.-9.;
  wp+=vec2(noise(vec3(p.xz*.09,3.)),noise(vec3(p.xz*.09,5.)))*6.-3.;
  return p+vec3(wp.x+uT*.12+p.y*.25,0.,wp.y+uT*.04);
}
float hg(float c,float g){ return (1.-g*g)/pow(1.+g*g-2.*g*c,1.5); }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
void main(){
  vec2 s=gl_FragCoord.xy/uRes*2.-1.;
  vec3 rd=normalize(uFw+uRt*(s.x*uTan.x)+uUp*(s.y*uTan.y));
  vec3 ro=uCam;
  SUN=normalize(uSun);
  SUNC=mix(vec3(1.,.50,.22),vec3(1.,.93,.82),smoothstep(.02,.55,SUN.y))*mix(1.,.5,uOver)*mix(1.,.08,uNight);
  AMBSKY=mix(vec3(.55,.38,.34),vec3(.30,.50,.85),smoothstep(0.,.7,SUN.y));
  AMBSKY=mix(AMBSKY,vec3(dot(AMBSKY,vec3(.33))),uOver*.7)*mix(1.,.65,uDark);
  AMBSKY=mix(AMBSKY,vec3(.05,.07,.14),uNight);
  float yt=uY0+11.;
  float sA=0.;
  if(rd.y<-.0005){
    float tg=-ro.y/rd.y;
    if(tg<500.){
      vec3 pg=ro+rd*tg;
      float sy=max(SUN.y,.2), s0=uY0/sy, ds=(11./sy)/8., od=0.;
      for(int k=0;k<6;k++){
        vec3 sp=pg+SUN*(s0+ds*(float(k)+.5)); float c,ty,dp,an;
        wx(sp.xz,c,ty,dp,an);
        od+=densBL(nq(sp),sp.y-uY0,c,ty,dp,0.)*ds;
      }
      sA=(1.-exp(-od*.5))*.48*exp(-tg/500.)*(1.-uNight*.45);
    }
  }
  vec3 col=vec3(0.); float T=1., tw=0.;
  float ybot=uRain>.01?0.:uY0;
  float t0=0., t1=0.; bool go=false;
  if(rd.y<-.0005){
    if(ro.y>ybot){ t0=ro.y>yt?(yt-ro.y)/rd.y:0.; t1=min((ybot-ro.y)/rd.y,t0+220.); go=true; }
  } else if(rd.y>.0005){
    if(ro.y<yt){ t0=ro.y<uY0?(uY0-ro.y)/rd.y:0.; t1=min((yt-ro.y)/rd.y,t0+220.); go=true; }
  }
  if(go){
    float dt=(t1-t0)/56.;
    float ign=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
    float t=t0+dt*ign;
    float ca=dot(rd,SUN), ph=.5*hg(ca,.6)+.5*hg(ca,-.2), ke=2.6+1.4*uDark;
    float sc=1.;
    for(int i=0;i<80;i++){
      if(t>t1) break;
      vec3 p=ro+rd*t; float yl=p.y-uY0; sc=1.;
      float nf=smoothstep(.5,5.,t);
      if(yl>=0.){
        float cov,typ,dep,anv;
        wx(p.xz,cov,typ,dep,anv);
        if(cov>.01){
          vec3 q=nq(p);
          float da=clamp(1.5-t*2.*uTan.y/uRes.y*6.,0.,1.);
          float d=densBL(q,yl,cov,typ,dep,da);
          if(d>.004){
            float stp=.6, pp=.3, lo=0.;
            for(int j=0;j<4;j++){
              vec3 sp=p+SUN*pp; float c2,t2,d2,a2;
              wx(sp.xz,c2,t2,d2,a2);
              lo+=densBL(q+SUN*pp,sp.y-uY0,c2,t2,d2,0.)*stp;
              pp+=stp; stp*=1.6;
            }
            lo*=ke*.5;
            float lt=exp(-lo*.8)+.2*exp(-lo*.18);
            float powder=1.-exp(-d*ke*2.);
            vec3 sunL=SUNC*1.7*lt*ph*mix(1.,powder,.4)*mix(1.,.35,uDark);
            float ao=exp(-(densBL(q+vec3(0.,1.5,0.),yl+1.5,cov,typ,dep,0.)+densBL(q+vec3(0.,4.,0.),yl+4.,cov,typ,dep,0.))*1.2);
            float hf=clamp(yl/max(dep,1.),0.,1.);
            vec3 amb=mix(vec3(.22,.26,.33),AMBSKY*1.1,smoothstep(0.,1.,hf))*(.25+.75*ao)*.7*mix(1.,.6,uDark);
            amb+=vec3(.55,.62,1.)*uFlash*(.5+.5*hf);
            sc=.5;
            float a=(1.-exp(-d*ke*dt*sc))*nf;
            col+=T*a*(sunL+amb)*mix(vec3(1.),vec3(.5,.53,.6),uDark)*(1.-.3*uRain*smoothstep(5.,9.,dep));
            tw+=T*a*t; T*=1.-a;
            if(T<.03) break;
          }
        }
      } else if(uRain>.01){
        float h=uY0-p.y;
        vec2 off=p.xz+vec2(.35,.12)*h;
        float c3,t3,d3,a3;
        wx(off,c3,t3,d3,a3);
        float m=smoothstep(.55,.95,c3)*smoothstep(3.,6.,d3);
        float dr=m*smoothstep(.3,.8,noise(vec3(off*.5,p.y*.035+uT*.2)))*uRain;
        if(dr>.003){
          float a=(1.-exp(-dr*dt*.45))*nf;
          vec3 rc=mix(vec3(.52,.56,.62),vec3(.9,.93,.98),uSnow)*mix(1.,.55,uDark)+vec3(.5,.55,.8)*uFlash*.5;
          col+=T*a*rc; tw+=T*a*t; T*=1.-a;
          if(T<.03) break;
        }
      }
      t+=dt*sc;
    }
  }
  float cv=1.-T;
  float fade=cv>.001?exp(-(tw/cv)/260.):1.;
  float cA=cv*uOpacity*fade;
  vec3 rgb=aces(col/max(cv,.001)*.9);
  float l=dot(rgb,vec3(.299,.587,.114));
  rgb=pow(max(mix(vec3(l),rgb,1.1),0.),vec3(1./2.2));
  gl_FragColor=vec4(rgb*cA,cA+(1.-cA)*sA);
}`

const BLIT_FRAG = `
precision mediump float;
uniform vec2 uRes; uniform sampler2D uImg;
void main(){ gl_FragColor=texture2D(uImg,gl_FragCoord.xy/uRes); }`

function makeNoiseAtlas() {
  const N = 48, T = 50, G = 7, S = 350
  let seed = 1337
  const rnd = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
  const table = (f, k) => { const a = new Float32Array(f * f * f * k); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a }
  const vt = { 4: table(4, 1), 8: table(8, 1), 16: table(16, 1) }
  const wt = { 4: table(4, 3), 8: table(8, 3), 16: table(16, 3) }
  const sm = t => t * t * (3 - 2 * t)
  const lerp = (a, b, t) => a + (b - a) * t
  function vnoise(f, x, y, z) {
    const tab = vt[f], xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
    const fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi)
    const g = (a, b, c) => tab[((c % f) * f + (b % f)) * f + (a % f)]
    return lerp(
      lerp(lerp(g(xi, yi, zi), g(xi + 1, yi, zi), fx), lerp(g(xi, yi + 1, zi), g(xi + 1, yi + 1, zi), fx), fy),
      lerp(lerp(g(xi, yi, zi + 1), g(xi + 1, yi, zi + 1), fx), lerp(g(xi, yi + 1, zi + 1), g(xi + 1, yi + 1, zi + 1), fx), fy),
      fz)
  }
  function worley(f, x, y, z) {
    const tab = wt[f], xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
    let md = 9
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy, cz = zi + dz
      const wx = ((cx % f) + f) % f, wy = ((cy % f) + f) % f, wz = ((cz % f) + f) % f
      const i = ((wz * f + wy) * f + wx) * 3
      const px = cx + tab[i] - x, py = cy + tab[i + 1] - y, pz = cz + tab[i + 2] - z
      const d = Math.sqrt(px * px + py * py + pz * pz)
      if (d < md) md = d
    }
    return Math.max(0, 1 - md)
  }
  const u8 = v => Math.round(255 * Math.max(0, Math.min(1, v)))
  const vox = new Uint8Array(N * N * N * 4)
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N
    const perlin = (.5 * vnoise(4, u * 4, v * 4, w * 4) + .25 * vnoise(8, u * 8, v * 8, w * 8)
      + .125 * vnoise(16, u * 16, v * 16, w * 16)) / .875
    const w4 = worley(4, u * 4, v * 4, w * 4)
    const o = ((z * N + y) * N + x) * 4
    vox[o] = u8(.5 + (perlin - .5) * 1.6 + (w4 - .48) * 1.2)
    vox[o + 1] = u8(w4)
    vox[o + 2] = u8(worley(8, u * 8, v * 8, w * 8))
    vox[o + 3] = u8(worley(16, u * 16, v * 16, w * 16))
  }
  const atlas = new Uint8Array(S * S * 4)
  for (let zi = 0; zi < N; zi++) {
    const ox = (zi % G) * T, oy = Math.floor(zi / G) * T
    for (let py = 0; py < T; py++) {
      const sy = (py - 1 + N) % N
      for (let px = 0; px < T; px++) {
        const sx = (px - 1 + N) % N
        const s = ((zi * N + sy) * N + sx) * 4, d = ((oy + py) * S + (ox + px)) * 4
        atlas[d] = vox[s]; atlas[d + 1] = vox[s + 1]; atlas[d + 2] = vox[s + 2]; atlas[d + 3] = vox[s + 3]
      }
    }
  }
  return { size: S, data: atlas }
}

//            dark  over  rain  snow
const LOOKS = [[0, 0, 0, 0], [.2, .25, 0, 0], [.5, .8, 0, 0], [.75, 1, .8, 0], [1, 1, 1.1, 0], [.4, .9, .6, 1]]

export function classifyWeather(weather) {
  const w = weather ?? {}
  const num = (...keys) => {
    for (const key of keys) {
      const value = Number(w[key])
      if (w[key] != null && w[key] !== '' && Number.isFinite(value)) return value
    }
    return null
  }
  const text = String(w.description ?? w.condition ?? w.summary ?? w.label ?? w.weatherLabel ?? '').toLowerCase()
  const cover = Math.max(0, Math.min(100, num('cloudCover', 'cloud_cover', 'cloudcover', 'clouds') ?? 40)) / 100
  const code = num('weatherCode', 'weather_code', 'code', 'wmo')
  const precip = num('precipitation', 'precip', 'rain', 'rainfall', 'precipitationMm', 'precipitation_mm', 'rainMm') ?? 0
  const thunder = (code != null && code >= 95 && code <= 99) || /thunder|storm/.test(text)
  const snow = (code != null && ((code >= 71 && code <= 77) || code === 85 || code === 86)) || /snow/.test(text)
  const rain = precip > 0.1 || (code != null && ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)))
    || /rain|drizzle|shower/.test(text)
  let cond = 1
  if (thunder) cond = 4
  else if (snow) cond = 5
  else if (rain) cond = 3
  else if (cover >= 0.85) cond = 2
  else if (cover < 0.3) cond = 0
  const wet = cond === 3 || cond === 4 || cond === 5
  return {
    cond,
    cover: Math.max(MIN_VISUAL_CLOUD_COVER, Math.min(1, wet ? Math.max(cover, 0.7) : cover)),
  }
}

export default class VolumetricCloudLayer3D {
  constructor(options = {}) {
    this.id = options.id ?? 'volumetric-clouds'
    this.type = 'custom'
    this.renderingMode = '2d'
    this.enabled = options.enabled !== false
    this.opacity = options.opacity ?? 1.0          // more visible
    this.baseHeightM = options.baseHeightM ?? CLOUD_BASE_M
    this.sunElevation = options.sunElevation ?? 0.8
    this._weather = options.weather ?? {}
    this._lighting = options.lighting ?? null
    this._look = classifyWeather(this._weather)
    this._bakedKey = ''
    this._time = Math.random() * 100
    this._flash = 0
    this._nextFlash = 2
    this._scale = MAX_RENDER_SCALE
    this._frames = 0
    this._acc = 0
    this._last = 0
    this._groundM = 0
    this._groundFrame = -999
    this._failed = false
  }

  updateWeather(weather, lighting) {
    this._weather = weather ?? {}
    if (lighting) this._lighting = lighting
    this._look = classifyWeather(this._weather)
    this.map?.triggerRepaint()
  }

  // Call this whenever the GPS sensor position changes so clouds stay over the sensor
  setOrigin(lng, lat) {
    if (!this._origin) return   // not yet initialised
    const merc = this._mercator(lng, lat)
    this._origin = { lng, lat, x: merc.x, y: merc.y }
    this._k = 1 / (EARTH_C * Math.cos(lat * Math.PI / 180))
    this._groundKnown = false   // re-query terrain elevation at new origin
    this.map?.triggerRepaint()
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    this.map?.triggerRepaint()
  }

  onAdd(map, gl) {
    this.map = map
    this.gl = gl
    try {
      this._init(gl)
    } catch (error) {
      console.error('[VolumetricCloudLayer3D] disabled:', error)
      this._failed = true
    }
    this._onVisibility = () => { if (!document.hidden) map.triggerRepaint() }
    document.addEventListener('visibilitychange', this._onVisibility)
  }

  _compile(gl, type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Cloud shader failed to compile: ${gl.getShaderInfoLog(shader)}`)
    }
    return shader
  }

  _program(gl, fragment, uniforms) {
    const program = gl.createProgram()
    gl.attachShader(program, this._compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, this._compile(gl, gl.FRAGMENT_SHADER, fragment))
    gl.bindAttribLocation(program, 0, 'a')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Cloud program failed to link: ${gl.getProgramInfoLog(program)}`)
    }
    const locations = {}
    for (const name of uniforms) locations[name] = gl.getUniformLocation(program, name)
    return { program, u: locations }
  }

  _texture(gl, width, height, data, wrap) {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    return texture
  }

  _init(gl) {
    this._bake = this._program(gl, COMMON + BAKE_MAIN, ['uT', 'uCond', 'uCover'])
    this._cloud = this._program(gl, COMMON + CLOUD_MAIN, [
      'uT', 'uCond', 'uCover', 'uRes', 'uTan', 'uY0', 'uDark', 'uOver', 'uRain', 'uSnow', 'uFlash',
      'uNight', 'uOpacity', 'uCam', 'uFw', 'uUp', 'uRt', 'uSun', 'uTex', 'uWx'])
    this._blit = this._program(gl, BLIT_FRAG, ['uRes', 'uImg'])

    this._buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    this._vaoExt = gl.createVertexArray ? null : gl.getExtension('OES_vertex_array_object')
    const createVao = gl.createVertexArray ? () => gl.createVertexArray() : this._vaoExt ? () => this._vaoExt.createVertexArrayOES() : null
    this._bindVao = gl.createVertexArray ? v => gl.bindVertexArray(v) : this._vaoExt ? v => this._vaoExt.bindVertexArrayOES(v) : () => {}
    this._vao = createVao ? createVao() : null
    if (this._vao) this._bindVao(this._vao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    if (this._vao) this._bindVao(null)

    const atlas = makeNoiseAtlas()
    this._noiseTex = this._texture(gl, atlas.size, atlas.size, atlas.data, gl.CLAMP_TO_EDGE)
    this._wxTex = this._texture(gl, 512, 512, null, gl.REPEAT)
    this._wxFbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._wxFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._wxTex, 0)
    this._rtTex = this._texture(gl, 2, 2, null, gl.CLAMP_TO_EDGE)
    this._rtFbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._rtFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._rtTex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this._rtW = 2
    this._rtH = 2

    const centre = this.map.getCenter()
    const merc = this._mercator(centre.lng, centre.lat)
    this._origin = { lng: centre.lng, lat: centre.lat, x: merc.x, y: merc.y }
    this._k = 1 / (EARTH_C * Math.cos(centre.lat * Math.PI / 180))
  }

  _mercator(lng, lat) {
    const x = (180 + lng) / 360
    const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360
    return { x, y }
  }

  _cameraMetres(args) {
    const map = this.map
    const bearing = map.getBearing() * Math.PI / 180
    const pitch = map.getPitch() * Math.PI / 180
    const fov = typeof args?.fov === 'number' && args.fov > 0.1 && args.fov < 2 ? args.fov : DEFAULT_FOV
    let east, north, altitude
    try {
      const position = map.getFreeCameraOptions().position
      east = (position.x - this._origin.x) / this._k
      north = -(position.y - this._origin.y) / this._k
      altitude = position.z / this._k
    } catch {
      east = NaN
    }
    if (!Number.isFinite(east)) {
      const centre = map.getCenter()
      const merc = this._mercator(centre.lng, centre.lat)
      const height = this.gl.drawingBufferHeight / (window.devicePixelRatio || 1)
      const metresPerPixel = EARTH_C * Math.cos(centre.lat * Math.PI / 180) / (512 * 2 ** map.getZoom())
      const distance = 0.5 * height / Math.tan(fov / 2) * metresPerPixel
      const forward = [Math.sin(bearing) * Math.sin(pitch), Math.cos(bearing) * Math.sin(pitch), -Math.cos(pitch)]
      east = (merc.x - this._origin.x) / this._k - forward[0] * distance
      north = -(merc.y - this._origin.y) / this._k - forward[1] * distance
      altitude = (map.queryTerrainElevation?.(centre) ?? 0) - forward[2] * distance
    }
    return { east, north, altitude, bearing, pitch, fov }
  }

  render(gl, args) {
    if (!this.enabled || this._failed || !this._cloud) return
    const map = this.map
    const now = performance.now() / 1000
    const rawDt = this._last ? now - this._last : 0.016
    this._last = now
    const dt = Math.min(0.1, rawDt)
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion) this._time += dt

    this._acc += rawDt
    if (++this._frames === 30) {
      const average = this._acc / 30
      if (average > 0.034 && this._scale > 0.3) this._scale = Math.max(0.3, this._scale - 0.07)
      else if (average < 0.019 && this._scale < MAX_RENDER_SCALE) {
        this._scale = Math.min(MAX_RENDER_SCALE, this._scale + 0.07)
      }
      this._acc = 0
      this._frames = 0
    }

    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    const renderScale = Math.min(this._scale, MAX_RENDER_SCALE)
    const rtW = Math.max(2, Math.floor(width * renderScale))
    const rtH = Math.max(2, Math.floor(height * renderScale))

    this._groundFrame++
    if (this._groundFrame > 120 || (this._groundFrame > 10 && !this._groundKnown)) {
      this._groundFrame = 0
      const elevation = map.queryTerrainElevation?.([this._origin.lng, this._origin.lat])
      if (Number.isFinite(elevation)) { this._groundM = elevation; this._groundKnown = true }
    }

    const camera = this._cameraMetres(args)
    const layerTopM = this.baseHeightM + 11 * UNIT_M
    const heightAboveGround = camera.altitude - this._groundM
    const visibility = Math.max(0, Math.min(1, (heightAboveGround - (layerTopM - 10)) / 30))
    if (visibility < 0.01) return

    const sinB = Math.sin(camera.bearing), cosB = Math.cos(camera.bearing)
    const sinP = Math.sin(camera.pitch), cosP = Math.cos(camera.pitch)
    const forward = [sinB * sinP, cosB * sinP, -cosP]
    const up = [sinB * cosP, cosB * cosP, sinP]
    const right = [
      forward[1] * up[2] - forward[2] * up[1],
      forward[2] * up[0] - forward[0] * up[2],
      forward[0] * up[1] - forward[1] * up[0],
    ]
    const toShader = v => [v[0], v[2], v[1]]
    const tanHalf = Math.tan(camera.fov / 2)

    const lighting = this._lighting
    const azimuth = Number.isFinite(lighting?.azimuth) ? lighting.azimuth : 135
    const polar = Number.isFinite(lighting?.polar) ? lighting.polar : 90 - this.sunElevation * 180 / Math.PI
    const polarRad = Math.max(0.05, Math.min(1.5, polar * Math.PI / 180))
    const azimuthRad = azimuth * Math.PI / 180
    const sun = [Math.sin(azimuthRad) * Math.sin(polarRad), Math.cos(polarRad), Math.cos(azimuthRad) * Math.sin(polarRad)]
    const night = lighting?.phase === 'Night' ? 1 : 0

    const { cond, cover } = this._look
    const look = LOOKS[cond]

    if (cond === 4 && !reduceMotion) {
      this._nextFlash -= dt
      if (this._nextFlash < 0) { this._flash = 1; this._nextFlash = 1.5 + Math.random() * 4 }
    }
    this._flash = Math.max(0, this._flash - dt * 4)

    const previousFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const viewport = gl.getParameter(gl.VIEWPORT)

    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)
    gl.depthMask(false)
    gl.colorMask(true, true, true, true)

    if (this._vao) this._bindVao(this._vao)
    else { gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0) }

    const key = `${cond}:${cover.toFixed(2)}`
    if (key !== this._bakedKey) {
      this._bakedKey = key
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._wxFbo)
      gl.viewport(0, 0, 512, 512)
      gl.disable(gl.BLEND)
      gl.useProgram(this._bake.program)
      gl.uniform1f(this._bake.u.uT, 0)
      gl.uniform1f(this._bake.u.uCond, cond)
      gl.uniform1f(this._bake.u.uCover, cover)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    if (rtW !== this._rtW || rtH !== this._rtH) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this._rtTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rtW, rtH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      this._rtW = rtW
      this._rtH = rtH
    }

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._noiseTex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this._wxTex)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._rtFbo)
    gl.viewport(0, 0, rtW, rtH)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const u = this._cloud.u
    gl.useProgram(this._cloud.program)
    gl.uniform1i(u.uTex, 0)
    gl.uniform1i(u.uWx, 1)
    gl.uniform1f(u.uT, this._time)
    gl.uniform1f(u.uCond, cond)
    gl.uniform1f(u.uCover, cover)
    gl.uniform2f(u.uRes, rtW, rtH)
    gl.uniform2f(u.uTan, tanHalf * width / height, tanHalf)
    gl.uniform1f(u.uY0, this.baseHeightM / UNIT_M)
    gl.uniform1f(u.uDark, look[0] * (night ? 0.6 : 0.45))
    gl.uniform1f(u.uOver, look[1])
    gl.uniform1f(u.uRain, look[2])
    gl.uniform1f(u.uSnow, look[3])
    gl.uniform1f(u.uFlash, this._flash * (0.6 + 0.4 * Math.random()))
    gl.uniform1f(u.uNight, night)
    gl.uniform1f(u.uOpacity, this.opacity * visibility * (cond >= 2 ? (night ? 0.95 : 1.15) : 1.1))
    gl.uniform3f(u.uCam, camera.east / UNIT_M, (camera.altitude - this._groundM) / UNIT_M, camera.north / UNIT_M)
    gl.uniform3fv(u.uFw, toShader(forward))
    gl.uniform3fv(u.uUp, toShader(up))
    gl.uniform3fv(u.uRt, toShader(right))
    gl.uniform3fv(u.uSun, sun.length === 3 ? [sun[0], sun[1], sun[2]] : [0, 1, 0])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFbo)
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3])
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this._rtTex)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this._blit.program)
    gl.uniform1i(this._blit.u.uImg, 2)
    gl.uniform2f(this._blit.u.uRes, viewport[2], viewport[3])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
    if (this._vao) this._bindVao(null)
    gl.depthMask(true)

    if (!document.hidden) map.triggerRepaint()
  }

  onRemove(map, gl) {
    document.removeEventListener('visibilitychange', this._onVisibility)
    if (!this._cloud) return
    gl.deleteProgram(this._bake.program)
    gl.deleteProgram(this._cloud.program)
    gl.deleteProgram(this._blit.program)
    gl.deleteBuffer(this._buffer)
    if (this._vao) {
      if (gl.deleteVertexArray) gl.deleteVertexArray(this._vao)
      else this._vaoExt?.deleteVertexArrayOES(this._vao)
    }
    gl.deleteTexture(this._noiseTex)
    gl.deleteTexture(this._wxTex)
    gl.deleteTexture(this._rtTex)
    gl.deleteFramebuffer(this._wxFbo)
    gl.deleteFramebuffer(this._rtFbo)
    this._cloud = null
  }
}

export class CloudToggleControl {
  constructor(getLayer) {
    this._getLayer = getLayer
  }
  onAdd() {
    const container = document.createElement('div')
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    const button = document.createElement('button')
    button.type = 'button'
    button.title = 'Toggle clouds'
    button.setAttribute('aria-label', 'Toggle clouds')
    button.setAttribute('aria-pressed', 'true')
    button.textContent = '☁'
    button.style.fontSize = '18px'
    button.style.lineHeight = '29px'
    button.addEventListener('click', () => {
      const layer = this._getLayer()
      if (!layer) return
      const on = !layer.enabled
      layer.setEnabled(on)
      button.setAttribute('aria-pressed', String(on))
      button.style.opacity = on ? '1' : '0.45'
    })
    container.appendChild(button)
    this._container = container
    return container
  }
  onRemove() {
    this._container?.remove()
    this._container = null
  }
}
