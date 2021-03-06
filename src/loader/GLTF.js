/**
 * glTF Loader
 * Specification https://github.com/KhronosGroup/glTF/blob/master/specification/README.md
 *
 * TODO Morph targets
 */
import Base from '../core/Base';
import request from '../core/request';
import util from '../core/util';
import vendor from '../core/vendor';

import Scene from '../Scene';
import Material from '../Material';
import StandardMaterial from '../StandardMaterial';
import Mesh from '../Mesh';
import Node from '../Node';
import Texture from '../Texture';
import Texture2D from '../Texture2D';
import shaderLibrary from '../shader/library';
import Skeleton from '../Skeleton';
import Joint from '../Joint';
import PerspectiveCamera from '../camera/Perspective';
import OrthographicCamera from '../camera/Orthographic';
import glenum from '../core/glenum';

import BoundingBox from '../math/BoundingBox';

import TrackClip from '../animation/TrackClip';
import SamplerTrack from '../animation/SamplerTrack';

import StaticGeometry from '../StaticGeometry';

// Import builtin shader
import '../shader/builtin';

var semanticAttributeMap = {
    'NORMAL': 'normal',
    'POSITION': 'position',
    'TEXCOORD_0': 'texcoord0',
    'TEXCOORD_1': 'texcoord1',
    'WEIGHTS_0': 'weight',
    'JOINTS_0': 'joint',
    'COLOR': 'color'
};

var ARRAY_CTOR_MAP = {
    5120: vendor.Int8Array,
    5121: vendor.Uint8Array,
    5122: vendor.Int16Array,
    5123: vendor.Uint16Array,
    5125: vendor.Uint32Array,
    5126: vendor.Float32Array
};
var SIZE_MAP = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16
};

function getAccessorData(json, lib, accessorIdx, isIndices) {
    var accessorInfo = json.accessors[accessorIdx];

    var buffer = lib.bufferViews[accessorInfo.bufferView];
    var byteOffset = accessorInfo.byteOffset || 0;
    var ArrayCtor = ARRAY_CTOR_MAP[accessorInfo.componentType] || vendor.Float32Array;

    var size = SIZE_MAP[accessorInfo.type];
    if (size == null && isIndices) {
        size = 1;
    }
    var arr = new ArrayCtor(buffer, byteOffset, size * accessorInfo.count);

    var quantizeExtension = accessorInfo.extensions && accessorInfo.extensions['WEB3D_quantized_attributes'];
    if (quantizeExtension) {
        var decodedArr = new vendor.Float32Array(size * accessorInfo.count);
        var decodeMatrix = quantizeExtension.decodeMatrix;
        var decodeOffset, decodeScale;
        var decodeOffset = new Array(size);
        var decodeScale = new Array(size);
        for (var k = 0; k < size; k++) {
            decodeOffset[k] = decodeMatrix[size * (size + 1) + k];
            decodeScale[k] = decodeMatrix[k * (size + 1) + k];
        }
        for (var i = 0; i < accessorInfo.count; i++) {
            for (var k = 0; k < size; k++) {
                decodedArr[i * size + k] = arr[i * size + k] * decodeScale[k] + decodeOffset[k];
            }
        }

        arr = decodedArr;
    }
    return arr;
}

/**
 * @typedef {Object} qtek.loader.GLTF.IResult
 * @property {qtek.Scene} scene
 * @property {qtek.Node} rootNode
 * @property {Object.<string, qtek.Camera>} cameras
 * @property {Object.<string, qtek.Texture>} textures
 * @property {Object.<string, qtek.Material>} materials
 * @property {Object.<string, qtek.Skeleton>} skeletons
 * @property {Object.<string, qtek.Mesh>} meshes
 */

/**
 * @constructor qtek.loader.GLTF
 * @extends qtek.core.Base
 */
var GLTFLoader = Base.extend(
/** @lends qtek.loader.GLTF# */
{
    /**
     * @type {qtek.Node}
     */
    rootNode: null,
    /**
     * @type {string}
     */
    rootPath: null,

    /**
     * @type {string}
     */
    textureRootPath: null,

    /**
     * @type {string}
     */
    bufferRootPath: null,

    /**
     * @type {string}
     */
    shaderName: 'qtek.standard',

    /**
     * @type {string}
     */
    useStandardMaterial: false,

    /**
     * @type {boolean}
     */
    includeCamera: true,

    /**
     * @type {boolean}
     */
    includeAnimation: true,
    /**
     * @type {boolean}
     */
    includeMesh: true,
    /**
     * @type {boolean}
     */
    includeTexture: true,

    /**
     * @type {string}
     */
    crossOrigin: '',
    /**
     * @type {boolean}
     */
    // PENDING
    // https://github.com/KhronosGroup/glTF/issues/674
    textureFlipY: false,

    shaderLibrary: null
},
function () {
    if (!this.shaderLibrary) {
        this.shaderLibrary = shaderLibrary.createLibrary();
    }
},
/** @lends qtek.loader.GLTF.prototype */
{
    /**
     * @param  {string} url
     */
    load: function (url) {
        var self = this;

        if (this.rootPath == null) {
            this.rootPath = url.slice(0, url.lastIndexOf('/'));
        }

        request.get({
            url: url,
            onprogress: function (percent, loaded, total) {
                self.trigger('progress', percent, loaded, total);
            },
            onerror: function (e) {
                self.trigger('error', e);
            },
            responseType: 'text',
            onload: function (data) {
                self.parse(JSON.parse(data));
            }
        });
    },

    /**
     * @param {Object} json
     * @param {Array.<ArrayBuffer>} [buffer]
     * @return {qtek.loader.GLTF.IResult}
     */
    parse: function (json, buffers) {
        var self = this;

        var lib = {
            buffers: [],
            bufferViews: [],
            materials: [],
            textures: [],
            meshes: [],
            joints: [],
            skeletons: [],
            cameras: [],
            nodes: [],
            clips: []
        };
        // Mount on the root node if given
        var rootNode = this.rootNode || new Scene();

        var loading = 0;
        function checkLoad() {
            loading--;
            if (loading === 0) {
                afterLoadBuffer();
            }
        }
        // If already load buffers
        if (buffers) {
            lib.buffers = buffers.slice();
            afterLoadBuffer(true);
        }
        else {
            // Load buffers
            util.each(json.buffers, function (bufferInfo, idx) {
                loading++;
                var path = bufferInfo.uri;
    
                self._loadBuffer(path, function (buffer) {
                    lib.buffers[idx] = buffer;
                    checkLoad();
                }, checkLoad);
            });
        }

        function getResult() {
            return {
                scene: self.rootNode ? null : rootNode,
                rootNode: self.rootNode ? rootNode : null,
                cameras: lib.cameras,
                textures: lib.textures,
                materials: lib.materials,
                skeletons: lib.skeletons,
                meshes: lib.meshes,
                clips: lib.clips,
                nodes: lib.nodes
            };
        }

        function afterLoadBuffer(immediately) {
            // Buffer not load complete.
            if (lib.buffers.length !== json.buffers.length) {
                setTimeout(function () {
                    self.trigger('error', 'Buffer not load complete.');
                });
                return;
            }

            json.bufferViews.forEach(function (bufferViewInfo, idx) {
                // PENDING Performance
                lib.bufferViews[idx] = lib.buffers[bufferViewInfo.buffer]
                    .slice(bufferViewInfo.byteOffset || 0, (bufferViewInfo.byteOffset || 0) + (bufferViewInfo.byteLength || 0));
            });
            lib.buffers = null;
            if (self.includeMesh) {
                if (self.includeTexture) {
                    self._parseTextures(json, lib);
                }
                self._parseMaterials(json, lib);
                self._parseMeshes(json, lib);
            }
            self._parseNodes(json, lib);

            // Only support one scene.
            if (json.scenes) {
                var sceneInfo = json.scenes[json.scene || 0]; // Default use the first scene.
                if (sceneInfo) {
                    for (var i = 0; i < sceneInfo.nodes.length; i++) {
                        var node = lib.nodes[sceneInfo.nodes[i]];
                        node.update();
                        rootNode.add(node);
                    }
                }
            }

            if (self.includeMesh) {
                self._parseSkins(json, lib);
            }

            if (self.includeAnimation) {
                self._parseAnimations(json, lib);
            }
            if (immediately) {
                setTimeout(function () {
                    self.trigger('success', getResult());
                });
            }
            else {
                self.trigger('success', getResult());
            }
        }

        return getResult();
    },

    /**
     * Binary file path resolver. User can override it
     * @param {string} path
     */
    resolveBinaryPath: function (path) {
        var rootPath = this.bufferRootPath;
        if (rootPath == null) {
            rootPath = this.rootPath;
        }
        return util.relative2absolute(path, rootPath);
    },

    /**
     * Texture file path resolver. User can override it
     * @param {string} path
     */
    resolveTexturePath: function (path) {
        var rootPath = this.textureRootPath;
        if (rootPath == null) {
            rootPath = this.rootPath;
        }
        return util.relative2absolute(path, rootPath);
    },

    _loadBuffer: function (path, onsuccess, onerror) {
        request.get({
            url: this.resolveBinaryPath(path),
            responseType: 'arraybuffer',
            onload: function (buffer) {
                onsuccess && onsuccess(buffer);
            },
            onerror: function (buffer) {
                onerror && onerror(buffer);
            }
        });
    },

    // https://github.com/KhronosGroup/glTF/issues/100
    // https://github.com/KhronosGroup/glTF/issues/193
    _parseSkins: function (json, lib) {

        // Create skeletons and joints
        var haveInvBindMatrices = false;
        util.each(json.skins, function (skinInfo, idx) {
            var skeleton = new Skeleton({
                name: skinInfo.name
            });
            for (var i = 0; i < skinInfo.joints.length; i++) {
                var nodeIdx = skinInfo.joints[i];
                var node = lib.nodes[nodeIdx];
                var joint = new Joint({
                    name: node.name,
                    node: node,
                    index: skeleton.joints.length
                });
                skeleton.joints.push(joint);
            }
            skeleton.relativeRootNode = lib.nodes[skinInfo.skeleton] || this.rootNode;
            if (skinInfo.inverseBindMatrices) {
                haveInvBindMatrices = true;
                var IBMInfo = json.accessors[skinInfo.inverseBindMatrices];
                var buffer = lib.bufferViews[IBMInfo.bufferView];

                var offset = IBMInfo.byteOffset || 0;
                var size = IBMInfo.count * 16;

                var array = new vendor.Float32Array(buffer, offset, size);

                skeleton.setJointMatricesArray(array);
            }
            else {
                skeleton.updateJointMatrices();
            }
            lib.skeletons[idx] = skeleton;
        }, this);

        var shaderLib = this.shaderLibrary;
        var shaderName = this.shaderName;
        function enableSkinningForMesh(mesh, skeleton, jointIndices) {
            mesh.skeleton = skeleton;
            mesh.joints = jointIndices;
            // Make sure meshs with different joints not have same material.
            var originalShader = mesh.material.shader;
            var material = mesh.material.clone();
            mesh.material = material;
            if (material instanceof StandardMaterial) {
                material.jointCount = jointIndices.length;
            }
            else {
                material.shader = shaderLib.get(
                    shaderName, {
                        textures: originalShader.getEnabledTextures(),
                        vertexDefines: {
                            SKINNING: null,
                            JOINT_COUNT: jointIndices.length
                        }
                    }
                );
            }
        }

        function getJointIndex(joint) {
            return joint.index;
        }

        util.each(json.nodes, function (nodeInfo, nodeIdx) {
            if (nodeInfo.skin != null) {
                var skinIdx = nodeInfo.skin;
                var skeleton = lib.skeletons[skinIdx];

                var node = lib.nodes[nodeIdx];
                var jointIndices = skeleton.joints.map(getJointIndex);
                if (node instanceof Mesh) {
                    enableSkinningForMesh(node, skeleton, jointIndices);
                }
                else {
                    // Mesh have multiple primitives
                    var children = node.children();
                    for (var i = 0; i < children.length; i++) {
                        enableSkinningForMesh(children[i], skeleton, jointIndices);
                    }
                }
            }
        }, this);
    },

    _parseTextures: function (json, lib) {
        util.each(json.textures, function (textureInfo, idx){
            // samplers is optional
            var samplerInfo = (json.samplers && json.samplers[textureInfo.sampler]) || {};
            var parameters = {};
            ['wrapS', 'wrapT', 'magFilter', 'minFilter'].forEach(function (name) {
                var value = samplerInfo[name];
                if (value != null) {
                    parameters[name] = value;
                }
            });
            util.defaults(parameters, {
                wrapS: Texture.REPEAT,
                wrapT: Texture.REPEAT,
                flipY: this.textureFlipY
            });

            var target = textureInfo.target || glenum.TEXTURE_2D;
            var format = textureInfo.format;
            if (format != null) {
                parameters.format = format;
            }

            if (target === glenum.TEXTURE_2D) {
                var texture = new Texture2D(parameters);
                var imageInfo = json.images[textureInfo.source];
                texture.load(this.resolveTexturePath(imageInfo.uri), this.crossOrigin);
                lib.textures[idx] = texture;
            }
        }, this);
    },

    _KHRCommonMaterialToStandard: function (materialInfo, lib) {
        var uniforms = {};
        var commonMaterialInfo = materialInfo.extensions['KHR_materials_common'];
        uniforms = commonMaterialInfo.values || {};

        if (typeof uniforms.diffuse === 'number') {
            uniforms.diffuse = lib.textures[uniforms.diffuse] || null;
        }
        if (typeof uniforms.emission === 'number') {
            uniforms.emission = lib.textures[uniforms.emission] || null;
        }

        var enabledTextures = [];
        if (uniforms['diffuse'] instanceof Texture2D) {
            enabledTextures.push('diffuseMap');
        }
        if (materialInfo.normalTexture) {
            enabledTextures.push('normalMap');
        }
        if (uniforms['emission'] instanceof Texture2D) {
            enabledTextures.push('emissiveMap');
        }
        var material;
        var isStandardMaterial = this.useStandardMaterial;
        if (isStandardMaterial) {
            material = new StandardMaterial({
                name: materialInfo.name,
                doubleSided: materialInfo.doubleSided
            });
        }
        else {
            var fragmentDefines = {
                USE_ROUGHNESS: null,
                USE_METALNESS: null
            };
            if (materialInfo.doubleSided) {
                fragmentDefines.DOUBLE_SIDED = null;
            }
            material = new Material({
                name: materialInfo.name,
                shader: this.shaderLibrary.get(this.shaderName, {
                    fragmentDefines: fragmentDefines,
                    textures: enabledTextures
                })
            });
        }

        if (uniforms.transparent) {
            material.depthMask = false;
            material.depthTest = true;
            material.transparent = true;
        }

        var diffuseProp = uniforms['diffuse'];
        if (diffuseProp) {
            // Color
            if (Array.isArray(diffuseProp)) {
                diffuseProp = diffuseProp.slice(0, 3);
                isStandardMaterial ? (material.color = diffuseProp)
                    : material.set('color', diffuseProp);
            }
            else { // Texture
                isStandardMaterial ? (material.diffuseMap = diffuseProp)
                    : material.set('diffuseMap', diffuseProp);
            }
        }
        var emissionProp = uniforms['emission'];
        if (emissionProp != null) {
            // Color
            if (Array.isArray(emissionProp)) {
                emissionProp = emissionProp.slice(0, 3);
                isStandardMaterial ? (material.emission = emissionProp)
                    : material.set('emission', emissionProp);
            }
            else { // Texture
                isStandardMaterial ? (material.emissiveMap = emissionProp)
                    : material.set('emissiveMap', emissionProp);
            }
        }
        if (materialInfo.normalTexture != null) {
            // TODO texCoord
            var normalTextureIndex = materialInfo.normalTexture.index;
            if (isStandardMaterial) {
                material.normalMap = lib.textures[normalTextureIndex] || null;
            }
            else {
                material.set('normalMap', lib.textures[normalTextureIndex] || null);
            }
        }
        if (uniforms['shininess'] != null) {
            var glossiness = Math.log(uniforms['shininess']) / Math.log(8192);
            // Uniform glossiness
            material.set('glossiness', glossiness);
            material.set('roughness', 1 - glossiness);
        }
        else {
            material.set('glossiness', 0.3);
            material.set('roughness', 0.3);
        }
        if (uniforms['specular'] != null) {
            material.set('specularColor', uniforms['specular'].slice(0, 3));
        }
        if (uniforms['transparency'] != null) {
            material.set('alpha', uniforms['transparency']);
        }

        return material;
    },

    _pbrMetallicRoughnessToStandard: function (materialInfo, metallicRoughnessMatInfo, lib) {
        var alphaTest = materialInfo.alphaMode === 'MASK';

        var isStandardMaterial = this.useStandardMaterial;
        var material;
        var diffuseMap, roughnessMap, metalnessMap, normalMap, emissiveMap;
        var enabledTextures = [];
            // TODO texCoord
        if (metallicRoughnessMatInfo.baseColorTexture) {
            diffuseMap = lib.textures[metallicRoughnessMatInfo.baseColorTexture.index] || null;
            diffuseMap && enabledTextures.push('diffuseMap');
        }
        if (metallicRoughnessMatInfo.metallicRoughnessTexture) {
            roughnessMap = metalnessMap = lib.textures[metallicRoughnessMatInfo.metallicRoughnessTexture.index] || null;
            roughnessMap && enabledTextures.push('metalnessMap', 'roughnessMap');
        }
        if (materialInfo.normalTexture) {
            normalMap = lib.textures[materialInfo.normalTexture.index] || null;
            normalMap && enabledTextures.push('normalMap');
        }
        if (materialInfo.emissiveTexture) {
            emissiveMap = lib.textures[materialInfo.emissiveTexture.index] || null;
            emissiveMap && enabledTextures.push('emissiveMap');
        }
        var baseColor = metallicRoughnessMatInfo.baseColorFactor || [1, 1, 1, 1];

        var commonProperties = {
            diffuseMap: diffuseMap || null,
            roughnessMap: roughnessMap || null,
            metalnessMap: metalnessMap || null,
            normalMap: normalMap || null,
            emissiveMap: emissiveMap || null,
            color: baseColor.slice(0, 3),
            alpha: baseColor[3],
            metalness: metallicRoughnessMatInfo.metallicFactor || 0,
            roughness: metallicRoughnessMatInfo.roughnessFactor || 0,
            emission: materialInfo.emissiveFactor || [0, 0, 0],
            alphaCutoff: materialInfo.alphaCutoff || 0
        };
        if (commonProperties.roughnessMap) {
            // In glTF metallicFactor will do multiply, which is different from StandardMaterial.
            // So simply ignore it
            commonProperties.metalness = 0.5;
            commonProperties.roughness = 0.5;
        }
        if (isStandardMaterial) {
            material = new StandardMaterial(util.extend({
                name: materialInfo.name,
                alphaTest: alphaTest,
                doubleSided: materialInfo.doubleSided,
                // G channel
                roughnessChannel: 1,
                // B Channel
                metalnessChannel: 2
            }, commonProperties));
        }
        else {
            var fragmentDefines = {
                ROUGHNESS_CHANNEL: 1,
                METALNESS_CHANNEL: 2,
                USE_ROUGHNESS: null,
                USE_METALNESS: null
            };
            if (alphaTest) {
                fragmentDefines.ALPHA_TEST = null;
            }
            if (materialInfo.doubleSided) {
                fragmentDefines.DOUBLE_SIDED = null;
            }
            material = new Material({
                name: materialInfo.name,
                shader: this.shaderLibrary.get(this.shaderName, {
                    fragmentDefines: fragmentDefines,
                    textures: enabledTextures
                })
            });
            material.set(commonProperties);
        }

        if (materialInfo.alphaMode === 'BLEND') {
            material.depthMask = false;
            material.depthTest = true;
            material.transparent = true;
        }

        return material;
    },

    _pbrSpecularGlossinessToStandard: function (materialInfo, specularGlossinessMatInfo, lib) {
        var alphaTest = materialInfo.alphaMode === 'MASK';

        if (this.useStandardMaterial) {
            console.error('StandardMaterial doesn\'t support specular glossiness workflow yet');
        }

        var material;
        var diffuseMap, glossinessMap, specularMap, normalMap, emissiveMap;
        var enabledTextures = [];
            // TODO texCoord
        if (specularGlossinessMatInfo.diffuseTexture) {
            diffuseMap = lib.textures[specularGlossinessMatInfo.diffuseTexture.index] || null;
            diffuseMap && enabledTextures.push('diffuseMap');
        }
        if (specularGlossinessMatInfo.specularGlossinessTexture) {
            glossinessMap = specularMap = lib.textures[specularGlossinessMatInfo.specularGlossinessTexture.index] || null;
            glossinessMap && enabledTextures.push('specularMap', 'glossinessMap');
        }
        if (materialInfo.normalTexture) {
            normalMap = lib.textures[materialInfo.normalTexture.index] || null;
            normalMap && enabledTextures.push('normalMap');
        }
        if (materialInfo.emissiveTexture) {
            emissiveMap = lib.textures[materialInfo.emissiveTexture.index] || null;
            emissiveMap && enabledTextures.push('emissiveMap');
        }
        var diffuseColor = specularGlossinessMatInfo.diffuseFactor || [1, 1, 1, 1];

        var commonProperties = {
            diffuseMap: diffuseMap || null,
            glossinessMap: glossinessMap || null,
            specularMap: specularMap || null,
            normalMap: normalMap || null,
            emissiveMap: emissiveMap || null,
            color: diffuseColor.slice(0, 3),
            alpha: diffuseColor[3],
            specularColor: specularGlossinessMatInfo.specularFactor || [1, 1, 1],
            glossiness: specularGlossinessMatInfo.glossinessFactor || 0,
            emission: materialInfo.emissiveFactor || [0, 0, 0],
            alphaCutoff: materialInfo.alphaCutoff == null ? 0.9 : materialInfo.alphaCutoff
        };
        if (commonProperties.glossinessMap) {
            // Ignore specularFactor
            commonProperties.glossiness = 0.5;
        }
        if (commonProperties.specularMap) {
            // Ignore specularFactor
            commonProperties.specularColor = [1, 1, 1];
        }

        var fragmentDefines = {
            GLOSSINESS_CHANNEL: 3
        };
        if (alphaTest) {
            fragmentDefines.ALPHA_TEST = null;
        }
        if (materialInfo.doubleSided) {
            fragmentDefines.DOUBLE_SIDED = null;
        }
        material = new Material({
            name: materialInfo.name,
            shader: this.shaderLibrary.get(this.shaderName, {
                fragmentDefines: fragmentDefines,
                textures: enabledTextures
            })
        });
        material.set(commonProperties);

        if (materialInfo.alphaMode === 'BLEND') {
            material.depthMask = false;
            material.depthTest = true;
            material.transparent = true;
        }

        return material;
    },

    _parseMaterials: function (json, lib) {
        util.each(json.materials, function (materialInfo, idx) {
            if (materialInfo.extensions && materialInfo.extensions['KHR_materials_common']) {
                lib.materials[idx] = this._KHRCommonMaterialToStandard(materialInfo, lib);
            }
            else if (materialInfo.extensions && materialInfo.extensions['KHR_materials_pbrSpecularGlossiness']) {
                lib.materials[idx] = this._pbrSpecularGlossinessToStandard(materialInfo, materialInfo.extensions['KHR_materials_pbrSpecularGlossiness'], lib);
            }
            else {
                lib.materials[idx] = this._pbrMetallicRoughnessToStandard(materialInfo, materialInfo.pbrMetallicRoughness || {}, lib);
            }
        }, this);
    },

    _parseMeshes: function (json, lib) {
        var self = this;

        util.each(json.meshes, function (meshInfo, idx) {
            lib.meshes[idx] = [];
            // Geometry
            for (var pp = 0; pp < meshInfo.primitives.length; pp++) {
                var primitiveInfo = meshInfo.primitives[pp];
                var geometry = new StaticGeometry({
                    // PENDIGN
                    name: meshInfo.name,
                    boundingBox: new BoundingBox()
                });
                // Parse attributes
                var semantics = Object.keys(primitiveInfo.attributes);
                for (var ss = 0; ss < semantics.length; ss++) {
                    var semantic = semantics[ss];
                    var accessorIdx = primitiveInfo.attributes[semantic];
                    var attributeInfo = json.accessors[accessorIdx];
                    var attributeName = semanticAttributeMap[semantic];
                    if (!attributeName) {
                        continue;
                    }
                    var size = SIZE_MAP[attributeInfo.type];
                    var attributeArray = getAccessorData(json, lib, accessorIdx);
                    // WebGL attribute buffer not support uint32.
                    // Direct use Float32Array may also have issue.
                    if (attributeArray instanceof vendor.Uint32Array) {
                        attributeArray = new Float32Array(attributeArray);
                    }
                    if (semantic === 'WEIGHTS_0' && size === 4) {
                        // Weight data in QTEK has only 3 component, the last component can be evaluated since it is normalized
                        var weightArray = new attributeArray.constructor(attributeInfo.count * 3);
                        for (var i = 0; i < attributeInfo.count; i++) {
                            weightArray[i * 3] = attributeArray[i * 4];
                            weightArray[i * 3 + 1] = attributeArray[i * 4 + 1];
                            weightArray[i * 3 + 2] = attributeArray[i * 4 + 2];
                        }
                        geometry.attributes[attributeName].value = weightArray;
                    }
                    else {
                        geometry.attributes[attributeName].value = attributeArray;
                    }
                    var attributeType = 'float';
                    if (attributeArray instanceof vendor.Uint16Array) {
                        attributeType = 'ushort';
                    }
                    else if (attributeArray instanceof vendor.Int16Array) {
                        attributeType = 'short';
                    }
                    else if (attributeArray instanceof vendor.Uint8Array) {
                        attributeType = 'ubyte';
                    }
                    else if (attributeArray instanceof vendor.Int8Array) {
                        attributeType = 'byte';
                    }
                    geometry.attributes[attributeName].type = attributeType;

                    if (semantic === 'POSITION') {
                        // Bounding Box
                        var min = attributeInfo.min;
                        var max = attributeInfo.max;
                        if (min) {
                            geometry.boundingBox.min.set(min[0], min[1], min[2]);
                        }
                        if (max) {
                            geometry.boundingBox.max.set(max[0], max[1], max[2]);
                        }
                    }
                }

                // Parse indices
                if (primitiveInfo.indices != null) {
                    geometry.indices = getAccessorData(json, lib, primitiveInfo.indices, true);
                    if (geometry.vertexCount <= 0xffff && geometry.indices instanceof vendor.Uint32Array) {
                        geometry.indices = new vendor.Uint16Array(geometry.indices);
                    }   
                }

                var material = lib.materials[primitiveInfo.material];
                var materialInfo = (json.materials || [])[primitiveInfo.material];
                // Use default material
                if (!material) {
                    material = new Material({
                        shader: this.shaderLibrary.get(self.shaderName)
                    });
                }
                var mesh = new Mesh({
                    geometry: geometry,
                    material: material,
                    mode: [Mesh.POINTS, Mesh.LINES, Mesh.LINE_LOOP, Mesh.LINE_STRIP, Mesh.TRIANGLES, Mesh.TRIANGLE_STRIP, Mesh.TRIANGLE_FAN][primitiveInfo.mode] || Mesh.TRIANGLES,
                    ignoreGBuffer: material.transparent
                });
                if (materialInfo != null) {
                    mesh.culling = !materialInfo.doubleSided;
                }
                if (((material instanceof StandardMaterial) && material.normalMap)
                    || (material.shader && material.shader.isTextureEnabled('normalMap'))
                ) {
                    if (!mesh.geometry.attributes.tangent.value) {
                        mesh.geometry.generateTangents();
                    }
                }

                mesh.name = GLTFLoader.generateMeshName(json.meshes, idx, pp);

                lib.meshes[idx].push(mesh);
            }
        }, this);
    },

    _instanceCamera: function (json, nodeInfo) {
        var cameraInfo = json.cameras[nodeInfo.camera];

        if (cameraInfo.type === 'perspective') {
            var perspectiveInfo = cameraInfo.perspective || {};
            return new PerspectiveCamera({
                name: nodeInfo.name,
                aspect: perspectiveInfo.aspectRatio,
                fov: perspectiveInfo.yfov,
                far: perspectiveInfo.zfar,
                near: perspectiveInfo.znear
            });
        }
        else {
            var orthographicInfo = cameraInfo.orthographic || {};
            return new OrthographicCamera({
                name: nodeInfo.name,
                top: orthographicInfo.ymag,
                right: orthographicInfo.xmag,
                left: -orthographicInfo.xmag,
                bottom: -orthographicInfo.ymag,
                near: orthographicInfo.znear,
                far: orthographicInfo.zfar
            });
        }
    },

    _parseNodes: function (json, lib) {

        function instanceMesh(mesh) {
            return new Mesh({
                name: mesh.name,
                geometry: mesh.geometry,
                material: mesh.material,
                culling: mesh.culling,
                mode: mesh.mode
            });
        }

        util.each(json.nodes, function (nodeInfo, idx) {
            var node;
            if (nodeInfo.camera != null && this.includeCamera) {
                node = this._instanceCamera(json, nodeInfo);
                lib.cameras.push(node);
            }
            else if (nodeInfo.mesh != null && this.includeMesh) {
                var primitives = lib.meshes[nodeInfo.mesh];
                if (primitives) {
                    if (primitives.length === 1) {
                        // Replace the node with mesh directly
                        node = instanceMesh(primitives[0]);
                        node.setName(nodeInfo.name);
                    }
                    else {
                        node = new Node();
                        node.setName(nodeInfo.name);
                        for (var j = 0; j < primitives.length; j++) {
                            node.add(instanceMesh(primitives[j]));
                        }
                    }
                }
            }
            else {
                node = new Node();
                // PENDING Dulplicate name.
                node.setName(nodeInfo.name);
            }
            if (nodeInfo.matrix) {
                node.localTransform.setArray(nodeInfo.matrix);
                node.decomposeLocalTransform();
            }
            else {
                if (nodeInfo.translation) {
                    node.position.setArray(nodeInfo.translation);
                }
                if (nodeInfo.rotation) {
                    node.rotation.setArray(nodeInfo.rotation);
                }
                if (nodeInfo.scale) {
                    node.scale.setArray(nodeInfo.scale);
                }
            }

            lib.nodes[idx] = node;
        }, this);

        // Build hierarchy
        util.each(json.nodes, function (nodeInfo, idx) {
            var node = lib.nodes[idx];
            if (nodeInfo.children) {
                for (var i = 0; i < nodeInfo.children.length; i++) {
                    var childIdx = nodeInfo.children[i];
                    var child = lib.nodes[childIdx];
                    node.add(child);
                }
            }
        });
        },

    _parseAnimations: function (json, lib) {
        function checkChannelPath(channelInfo) {
            if (channelInfo.path === 'weights') {
                console.warn('GLTFLoader not support morph targets yet.');
                return false;
            }
            return true;
        }

        function getChannelHash(channelInfo, animationInfo) {
            return channelInfo.target.node + '_' + animationInfo.samplers[channelInfo.sampler].input;
        }

        var timeAccessorMultiplied = {};
        util.each(json.animations, function (animationInfo, idx) {
            var channels = animationInfo.channels.filter(checkChannelPath);

            if (!channels.length) {
                return;
            }
            var tracks = {};
            for (var i = 0; i < channels.length; i++) {
                var channelInfo = channels[i];
                var channelHash = getChannelHash(channelInfo, animationInfo);

                var targetNode = lib.nodes[channelInfo.target.node];
                var track = tracks[channelHash];
                var samplerInfo = animationInfo.samplers[channelInfo.sampler];

                if (!track) {
                    track = tracks[channelHash] = new SamplerTrack({
                        name: targetNode ? targetNode.name : '',
                        target: targetNode
                    });
                    track.targetNodeIndex = channelInfo.target.node;
                    track.channels.time = getAccessorData(json, lib, samplerInfo.input);
                    var frameLen = track.channels.time.length;
                    if (!timeAccessorMultiplied[samplerInfo.input]) {
                        for (var k = 0; k < frameLen; k++) {
                            track.channels.time[k] *= 1000;
                        }
                        timeAccessorMultiplied[samplerInfo.input] = true;
                    }
                }

                var interpolation = samplerInfo.interpolation || 'LINEAR';
                if (interpolation !== 'LINEAR') {
                    console.warn('GLTFLoader only support LINEAR interpolation.');
                }

                var path = channelInfo.target.path;
                if (path === 'translation') {
                    path = 'position';
                }

                track.channels[path] = getAccessorData(json, lib, samplerInfo.output);
            }
            var clip = new TrackClip({
                name: animationInfo.name,
                loop: true
            });
            for (var hash in tracks) {
                clip.addTrack(tracks[hash]);
            }
            clip.calcLifeFromTracks();
            lib.clips.push(clip);
        }, this);


        // PENDING
        var maxLife = lib.clips.reduce(function (maxTime, clip) {
            return Math.max(maxTime, clip.life);
        }, 0);
        lib.clips.forEach(function (clip) {
            clip.life = maxLife;
        });

        return lib.clips;
    }
});

GLTFLoader.generateMeshName = function (meshes, idx, primitiveIdx) {
    var meshInfo = meshes[idx];
    var meshName = meshInfo.name || ('mesh_' + idx);
    return primitiveIdx === 0 ? meshName : (meshName + '$' + primitiveIdx);
};

export default GLTFLoader;
