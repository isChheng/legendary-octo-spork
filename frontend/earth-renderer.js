const vertexSource = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentSource = `
precision highp float;
uniform vec2 center;
uniform float radius;
uniform vec2 latitude;
uniform float longitude;
uniform sampler2D earth;

void main() {
  vec2 p = (gl_FragCoord.xy - center) / radius;
  float depth = 1.0 - dot(p, p);
  if (depth <= 0.0) discard;

  float z = sqrt(depth);
  float angle = atan(p.x, z * latitude.y - p.y * latitude.x);
  float phi = asin(clamp(p.y * latitude.y + z * latitude.x, -1.0, 1.0));
  vec2 uv = vec2(0.5 + longitude + angle / 6.283185307, 0.5 - phi / 3.141592654);
  vec3 color = texture2D(earth, uv).rgb;
  float light = 0.32 + 0.58 * max(0.0, dot(vec3(p, z), vec3(-0.48, 0.42, 0.77)));
  float rim = (1.0 - z) * (1.0 - z);
  float alpha = min(1.0, depth * radius * 0.58);
  color = color * light + vec3(0.059, 0.169, 0.322) * rim * rim;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

export function createEarthRenderer(canvas) {
  const gl = canvas.getContext("webgl", { antialias: false, depth: false });
  if (!gl) return null;
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (vertex) {
    gl.attachShader(program, vertex);
    gl.deleteShader(vertex);
  }
  if (fragment) {
    gl.attachShader(program, fragment);
    gl.deleteShader(fragment);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([29, 52, 80, 255]));

  const centerLocation = gl.getUniformLocation(program, "center");
  const radiusLocation = gl.getUniformLocation(program, "radius");
  const latitudeLocation = gl.getUniformLocation(program, "latitude");
  const longitudeLocation = gl.getUniformLocation(program, "longitude");

  return {
    setImage(image) {
      // The bundled 4096×2048 image supports repeat wrapping and mipmaps in WebGL 1.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      if (gl.getError() !== gl.NO_ERROR) return false;
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      return true;
    },
    draw(width, height, radius, centerX, centerY, sinLat, cosLat, longitude) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(centerLocation, centerX, height - centerY);
      gl.uniform1f(radiusLocation, radius);
      gl.uniform2f(latitudeLocation, sinLat, cosLat);
      gl.uniform1f(longitudeLocation, longitude / 360);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
