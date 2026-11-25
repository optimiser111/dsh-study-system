import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function patchCapture(source) {
  const original = `      if (m_DeviceState != DeviceState::Stopping && !IsBufferSilent(Data, FramesAvailable, &m_CaptureFormat, -70))
      {
         size_t byteCount = FramesAvailable * m_CaptureFormat.nBlockAlign;
         EmitAudioData(Data, static_cast<UINT32>(byteCount));
      }`;
  const patched = `      if (m_DeviceState != DeviceState::Stopping)
      {
         size_t byteCount = FramesAvailable * m_CaptureFormat.nBlockAlign;
         // Study patch: silence has duration. Never remove quiet packets.
         // WASAPI may provide a null data pointer with the SILENT flag.
         if ((dwCaptureFlags & AUDCLNT_BUFFERFLAGS_SILENT) || Data == nullptr)
         {
            std::vector<BYTE> silence(byteCount, 0);
            EmitAudioData(silence.data(), static_cast<UINT32>(byteCount));
         }
         else
         {
            EmitAudioData(Data, static_cast<UINT32>(byteCount));
         }
      }`;
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized.split(original).length !== 2) throw new Error('Unexpected loopback-capture source; refusing to patch');
  return normalized.replace(original, patched);
}

export function prepareNative(projectRoot) {
  const dependency = path.join(projectRoot, 'node_modules/loopback-capture');
  if (JSON.parse(fs.readFileSync(path.join(dependency, 'package.json'))).version !== '4.0.0') throw new Error('Expected loopback-capture@4.0.0');
  const input = fs.readFileSync(path.join(dependency, 'src/platform/windows/LoopbackCapture.cpp'));
  if (createHash('sha256').update(input).digest('hex') !== '5121209bcee0714ef9a7d53d858354652d25908a9f16cb9e0db33ca4ad4057f6') throw new Error('Unexpected upstream capture source hash');
  const stage = path.join(projectRoot, '.probe/audio-native-source'), assets = path.join(projectRoot, '.probe/audio-native-assets');
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(dependency, 'src'), path.join(stage, 'src'), { recursive: true });
  fs.copyFileSync(path.join(dependency, 'LICENSE'), path.join(stage, 'LICENSE'));
  fs.writeFileSync(path.join(stage, 'src/platform/windows/LoopbackCapture.cpp'), patchCapture(input.toString('utf8')));
  const cmakePath = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(stage, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.15)
project(study_loopback LANGUAGES CXX)
add_library(loopback_capture_addon SHARED src/Addon.cpp src/platform/windows/LoopbackCapture.cpp src/platform/windows/LoopbackCaptureWrap.cpp)
set_target_properties(loopback_capture_addon PROPERTIES PREFIX "" SUFFIX ".node")
target_compile_definitions(loopback_capture_addon PRIVATE NAPI_VERSION=9)
target_compile_features(loopback_capture_addon PRIVATE cxx_std_20)
target_include_directories(loopback_capture_addon PRIVATE "${cmakePath(assets)}/node-v24.18.0/include/node" "${cmakePath(assets)}/package" "${cmakePath(assets)}/wil/include" src/platform/windows)
target_link_libraries(loopback_capture_addon PRIVATE "${cmakePath(assets)}/node.lib" windowsapp.lib mfuuid.lib)
`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareNative(path.resolve(process.argv[2]));
