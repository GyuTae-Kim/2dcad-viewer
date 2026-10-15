/**
 * 3D 뷰어 셰이더(GLSL ES 3.00).
 * - 그물: 시점 공간 조명(주광 + 보조광 + 주변광, 약한 반사광), 양면. 법선이 없으면 화면 미분으로 면 법선을 만든다(평면 음영).
 * - 굵은 선: 선분 하나 = 사각형 인스턴스 하나. 끝점을 클립 공간으로 옮긴 뒤 가까운 면에서 자르고, 화면 화소로 폭을 편다.
 *   선분 배열(xyz,xyz…)을 그대로 인스턴스 속성(보폭 24바이트)으로 읽는다.
 * - 가는 선: gl.LINES로 같은 버퍼(보폭 12바이트)를 그대로 그린다.
 * - 점: 사각형 인스턴스 + 원 모양 잘라내기.
 */

export const MESH_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec4 a_col;
uniform mat4 u_mvp;
uniform mat4 u_mv;
uniform mat3 u_nmat;
uniform vec4 u_color;
uniform float u_vcol;
out vec3 v_vpos;
out vec3 v_nrm;
out vec4 v_col;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  v_vpos = (u_mv * vec4(a_pos, 1.0)).xyz;
  v_nrm = u_nmat * a_nrm;
  v_col = u_vcol > 0.5 ? a_col : u_color;
}`;

export const MESH_FS = `#version 300 es
precision highp float;
in vec3 v_vpos;
in vec3 v_nrm;
in vec4 v_col;
uniform float u_hasNrm;
uniform float u_ortho;
uniform vec4 u_tint;
uniform float u_alpha;
out vec4 o_color;
void main() {
  vec3 V = u_ortho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-v_vpos);
  vec3 ng = cross(dFdx(v_vpos), dFdy(v_vpos));
  float lg = length(ng);
  ng = lg > 0.0 ? ng / lg : V;
  if (dot(ng, V) < 0.0) ng = -ng;
  vec3 n = ng;
  if (u_hasNrm > 0.5) {
    float ln = length(v_nrm);
    if (ln > 0.0) {
      n = v_nrm / ln;
      if (dot(n, ng) < 0.0) n = -n;
    }
  }
  vec3 L1 = normalize(vec3(-0.35, 0.55, 0.76));
  vec3 L2 = normalize(vec3(0.6, -0.3, 0.45));
  float dif = 0.30 + 0.60 * max(dot(n, L1), 0.0) + 0.20 * max(dot(n, L2), 0.0);
  float spec = pow(max(dot(n, normalize(L1 + V)), 0.0), 48.0) * 0.2;
  vec3 c = v_col.rgb * dif + vec3(spec);
  c = mix(c, u_tint.rgb, u_tint.a);
  o_color = vec4(c, v_col.a * u_alpha);
}`;

export const WIDE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_p0;
layout(location=2) in vec3 a_p1;
layout(location=3) in vec4 a_c0;
layout(location=4) in vec4 a_c1;
uniform mat4 u_mvp;
uniform vec2 u_viewport;
uniform float u_width;
uniform vec4 u_color;
uniform float u_vcol;
uniform float u_alpha;
uniform vec4 u_override;
uniform float u_bias;
out vec4 v_col;
out float v_alongW;
out float v_w;
void main() {
  vec4 c0 = u_mvp * vec4(a_p0, 1.0);
  vec4 c1 = u_mvp * vec4(a_p1, 1.0);
  float d0 = c0.z + c0.w;
  float d1 = c1.z + c1.w;
  if (d0 < 0.0 && d1 < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (d0 < 0.0) c0 = mix(c0, c1, d0 / (d0 - d1));
  else if (d1 < 0.0) c1 = mix(c1, c0, d1 / (d1 - d0));
  vec2 hv = 0.5 * u_viewport;
  vec2 s0 = c0.xy / c0.w * hv;
  vec2 s1 = c1.xy / c1.w * hv;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = max(u_width, 1.0) * 0.5;
  vec4 c = mix(c0, c1, a_corner.x);
  float ext = a_corner.x * 2.0 - 1.0;
  vec2 off = nrm * a_corner.y * hw + dir * ext * hw;
  c.xy += off / hv * c.w;
  c.z -= u_bias * c.w;
  gl_Position = c;
  vec4 col = u_vcol > 0.5 ? mix(a_c0, a_c1, a_corner.x) : u_color;
  if (u_override.a > 0.0) col = u_override;
  v_col = vec4(col.rgb, col.a * u_alpha);
  v_alongW = (a_corner.x * len + ext * hw) * c.w;
  v_w = c.w;
}`;

export const WIDE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
in float v_alongW;
in float v_w;
uniform vec2 u_dash;
out vec4 o_color;
void main() {
  if (u_dash.x > 0.0) {
    float along = v_alongW / v_w;
    if (mod(along, u_dash.x + u_dash.y) > u_dash.x) discard;
  }
  o_color = v_col;
}`;

export const THIN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec4 a_col;
uniform mat4 u_mvp;
uniform vec4 u_color;
uniform float u_vcol;
uniform float u_alpha;
uniform vec4 u_override;
uniform float u_bias;
out vec4 v_col;
void main() {
  vec4 c = u_mvp * vec4(a_pos, 1.0);
  c.z -= u_bias * c.w;
  gl_Position = c;
  vec4 col = u_vcol > 0.5 ? a_col : u_color;
  if (u_override.a > 0.0) col = u_override;
  v_col = vec4(col.rgb, col.a * u_alpha);
}`;

export const THIN_FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 o_color;
void main() {
  o_color = v_col;
}`;

export const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_pos;
uniform mat4 u_mvp;
uniform vec2 u_viewport;
uniform float u_size;
uniform float u_bias;
out vec2 v_c;
void main() {
  vec4 c = u_mvp * vec4(a_pos, 1.0);
  if (c.w <= 0.0 || c.z < -c.w) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float r = u_size * 0.5 + 1.0;
  c.xy += a_corner * r / (0.5 * u_viewport) * c.w;
  c.z -= u_bias * c.w;
  gl_Position = c;
  v_c = a_corner * r;
}`;

export const POINT_FS = `#version 300 es
precision highp float;
in vec2 v_c;
uniform float u_size;
uniform vec4 u_color;
uniform vec4 u_ring;
out vec4 o_color;
void main() {
  float r = length(v_c);
  float R = u_size * 0.5;
  if (r > R) discard;
  o_color = r > R - max(1.0, R * 0.25) ? u_ring : u_color;
}`;
