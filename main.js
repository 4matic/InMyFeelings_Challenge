const stats = new Stats();

const isAndroid = () => /Android/i.test(navigator.userAgent);
const isiOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isMobile = () => isAndroid() || isiOS();

let currentElement,
  net,
  isStopped = true,
  canvasWidth, canvasHeight;

const guiState = {
  algorithm: 'single-pose',
  input: {
    mobileNetArchitecture: isMobile() ? '0.50' : '1.01',
    outputStride: 16,
    imageScaleFactor: 0.5,
  },
  singlePoseDetection: {
    minPoseConfidence: 0.1,
    minPartConfidence: 0.5,
  },
  multiPoseDetection: {
    maxPoseDetections: 2,
    minPoseConfidence: 0.1,
    minPartConfidence: 0.3,
    nmsRadius: 20.0,
  },
  output: {
    showVideo: true,
    showSkeleton: true,
    showPoints: true,
  },
  net: null,
};

/**
 * Sets up dat.gui controller on the top-right of the window
 */
const setupGui = (cameras, net) => {
  guiState.net = net;

  if (cameras.length > 0) {
    guiState.camera = cameras[0].deviceId;
  }

  const cameraOptions = cameras.reduce((result, { label, deviceId }) => {
    result[label] = deviceId;
    return result;
  }, {});

  const gui = new dat.GUI({
    width: isMobile() ? 200: 300,
    closeOnTop: isMobile(),
    closed: isMobile(),
  });

  // The single-pose algorithm is faster and simpler but requires only one person to be
  // in the frame or results will be innaccurate. Multi-pose works for more than 1 person
  const algorithmController = gui.add(
    guiState, 'algorithm', ['single-pose', 'multi-pose']);

  // The input parameters have the most effect on accuracy and speed of the network
  let input = gui.addFolder('Input');
  // Architecture: there are a few PoseNet models varying in size and accuracy. 1.01
  // is the largest, but will be the slowest. 0.50 is the fastest, but least accurate.
  const architectureController =
    input.add(guiState.input, 'mobileNetArchitecture', ['1.01', '1.00', '0.75', '0.50']);
  // Output stride:  Internally, this parameter affects the height and width of the layers
  // in the neural network. The lower the value of the output stride the higher the accuracy
  // but slower the speed, the higher the value the faster the speed but lower the accuracy.
  input.add(guiState.input, 'outputStride', [8, 16, 32]);
  // Image scale factor: What to scale the image by before feeding it through the network.
  input.add(guiState.input, 'imageScaleFactor').min(0.2).max(1.0);
  input.open();

  // Pose confidence: the overall confidence in the estimation of a person's
  // pose (i.e. a person detected in a frame)
  // Min part confidence: the confidence that a particular estimated keypoint
  // position is accurate (i.e. the elbow's position)
  let single = gui.addFolder('Single Pose Detection');
  single.add(guiState.singlePoseDetection, 'minPoseConfidence', 0.0, 1.0);
  single.add(guiState.singlePoseDetection, 'minPartConfidence', 0.0, 1.0);
  single.open();

  let multi = gui.addFolder('Multi Pose Detection');
  multi.add(
    guiState.multiPoseDetection, 'maxPoseDetections').min(1).max(20).step(1);
  multi.add(guiState.multiPoseDetection, 'minPoseConfidence', 0.0, 1.0);
  multi.add(guiState.multiPoseDetection, 'minPartConfidence', 0.0, 1.0);
  // nms Radius: controls the minimum distance between poses that are returned
  // defaults to 20, which is probably fine for most use cases
  multi.add(guiState.multiPoseDetection, 'nmsRadius').min(0.0).max(40.0);

  let output = gui.addFolder('Output');
  output.add(guiState.output, 'showVideo');
  output.add(guiState.output, 'showSkeleton');
  output.add(guiState.output, 'showPoints');
  output.open();

  if(isMobile()) {
    gui.close();
  }

  architectureController.onChange(function (architecture) {
    guiState.changeToArchitecture = architecture;
  });

  algorithmController.onChange(function (value) {
    switch (guiState.algorithm) {
      case 'single-pose':
        multi.close();
        single.open();
        break;
      case 'multi-pose':
        single.close();
        multi.open();
        break;
    }
  });
};

/**
 * Sets up a frames per second panel on the top-left of the window
 */
const setupFPS = () => {
  stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
  document.body.appendChild(stats.dom);
};

/**
 * Feeds an image to posenet to estimate poses - this is where the magic happens.
 * This function loops with a requestAnimationFrame method.
 */
function detectPoseInRealTime(element, net) {
  const canvas = document.getElementById('output');
  const ctx = canvas.getContext('2d');
  const flipHorizontal = true; // since images are being fed from a webcam
  canvasWidth = element.clientWidth;
  canvasHeight = element.clientHeight;

  element.width = canvasWidth;
  element.height = canvasHeight;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  async function poseDetectionFrame() {
    console.log('poseDetectionFrame')
    if (guiState.changeToArchitecture) {
      // Important to purge variables and free up GPU memory
      guiState.net.dispose();

      // Load the PoseNet model weights for either the 0.50, 0.75, 1.00, or 1.01 version
      guiState.net = await posenet.load(Number(guiState.changeToArchitecture));

      guiState.changeToArchitecture = null;
    }

    // Begin monitoring code for frames per second
    stats.begin();

    // Scale an image down to a certain factor. Too large of an image will slow down
    // the GPU
    const imageScaleFactor = guiState.input.imageScaleFactor;
    const outputStride = Number(guiState.input.outputStride);

    let poses = [];
    let minPoseConfidence;
    let minPartConfidence;
    switch (guiState.algorithm) {
      case 'single-pose':
        const pose = await guiState.net.estimateSinglePose(element, imageScaleFactor, flipHorizontal, outputStride);
        poses.push(pose);

        minPoseConfidence = Number(
          guiState.singlePoseDetection.minPoseConfidence);
        minPartConfidence = Number(
          guiState.singlePoseDetection.minPartConfidence);
        break;
      case 'multi-pose':
        poses = await guiState.net.estimateMultiplePoses(element, imageScaleFactor, flipHorizontal, outputStride,
          guiState.multiPoseDetection.maxPoseDetections,
          guiState.multiPoseDetection.minPartConfidence,
          guiState.multiPoseDetection.nmsRadius);

        minPoseConfidence = Number(guiState.multiPoseDetection.minPoseConfidence);
        minPartConfidence = Number(guiState.multiPoseDetection.minPartConfidence);
        break;
    }

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    if (guiState.output.showVideo) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-canvasWidth, 0);
      ctx.drawImage(element, 0, 0, canvasWidth, canvasHeight);
      ctx.restore();
    }

    const scale = 1;

    // For each pose (i.e. person) detected in an image, loop through the poses
    // and draw the resulting skeleton and keypoints if over certain confidence
    // scores
    poses.forEach(({ score, keypoints }) => {
      if (score >= minPoseConfidence) {
        if (guiState.output.showPoints) {
          drawKeypoints(keypoints, minPartConfidence, ctx, scale);
        }
        if (guiState.output.showSkeleton) {
          drawSkeleton(keypoints, minPartConfidence, ctx, scale);
        }
      }
    });

    // End monitoring code for frames per second
    stats.end();

    if(!isStopped && currentElement.localName === 'video') {
      requestAnimationFrame(poseDetectionFrame);
    }
  }

  poseDetectionFrame();
}

jQuery(document).ready(function($){
  const $fileInput = $('#upload-file');
  const $giphyLink = $('#giphy-link');
  const $previewImage = $('#preview-image');
  const $previewVideo = $('#preview-video');
  const $submitForm = $('.submit-form');
  const $previewContainer = $('.preview');
  const $output = $('#output');

  $fileInput.change((event) => {
    event.preventDefault();
    const file = event.target.files[0];
    preprocessFile(file);
    $previewContainer.find('.title').text('Preview');
    $submitForm.find('[type="submit"]').removeAttr('disabled')
  });

  $giphyLink.change(async (event) => {
    try {
      $giphyLink.parent().find('.invalid-feedback').remove();
      event.preventDefault();
      const link = event.target.value;
      if(link) {
        const file = await downloadFile(link)
        const urlCreator = window.URL || window.webkitURL;
        const fileBlob = urlCreator.createObjectURL(file);
        showPreview(fileBlob, file.type)
        $previewContainer.find('.title').text('Preview');
        $submitForm.find('[type="submit"]').removeAttr('disabled');
      }
    } catch (err) {
      $giphyLink.parent().append('<div class="invalid-feedback">Failed to load resource, try another one. See developer console for more details.</div>')
    }
  });

  $('.try-link').on('click', (e) => {
    e.preventDefault();
    isStopped = true;
    const href = e.target.href;
    if(href) {
      $giphyLink.val(href);
      $giphyLink.change();
    }
  });

  $submitForm.on('submit', (event) => {
    event.preventDefault();
    if(currentElement) {
      // $previewContainer.hide();
      $output.parent().show();

      if (currentElement.localName === 'video') {
        currentElement.onpause = function() {
          console.log("The video has been paused");
        };
        currentElement.onstalled = function() {
          console.log("The video has been onstalled");
        };
        currentElement.play();
      }
      isStopped = false;

      $previewContainer.find('.title').text('Pose estimation');

      currentElement.width = undefined;
      currentElement.height = undefined;

      detectPoseInRealTime(currentElement, net);
    } else {
      $submitForm.prepend('<div class="alert alert-danger">Choose file or specify URL first!</div>')
    }
  });

  const downloadFile = (link) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", link);
      xhr.responseType = "blob";
      xhr.onload = (event) => {
        const blob = event.target.response;
        console.log('event.target', event.target)
        resolve(blob);
      };
      xhr.onerror = (event) => {
        console.error('event', event)
        reject(event);
      };
      xhr.send();
    });
  };

  const showPreview = (blob, type) => {
    $previewImage.parent().hide();
    $previewVideo.parent().hide();
    if(type.startsWith("image/")) {
      $previewImage.attr('src', blob);
      $previewImage.parent().show();
      currentElement = $previewImage[0];
    } else if(type.startsWith("video/")) {
      const $source = $previewVideo.find('source');
      if(!$source.length) {
        $('<source/>', {
          src: blob,
        }).appendTo($previewVideo);
      } else {
        $previewVideo[0].pause();
        $source.attr('src', blob);
        $previewVideo[0].load();
      }
      currentElement = $previewVideo[0];
      $previewVideo.parent().show();
    }
    $previewContainer.show();
  };

  const preprocessFile = (file) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      showPreview(reader.result, file.type)
    }, false);
    if (file) {
      reader.readAsDataURL(file);
    }
  };
  const setup = async () => {
    if(isMobile()) {
      $('body').addClass('mobile');
    }
    // Load the PoseNet model weights for version 1.01
    net = await posenet.load();
    setupGui([], net);
    setupFPS();
  };
  setup();
});


